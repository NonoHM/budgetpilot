import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { readDashboardPeriodData } from '$lib/server/dashboard/periodData';
import { parseDateRange } from '$lib/server/date-range';
import { prepareAdvice } from './gateway';
import { acceptPicks } from './statements';

/**
 * #996, at the seam the contradiction pass on the design note found the defect in: the facts a pick
 * is checked against, read the way the advice route reads them (`readDashboardPeriodData`, then
 * `prepareAdvice`), from a real engine.
 *
 * Budgets reach the period's summary on a whole-month period only. On « last 30 days » every
 * category reads with no budget status at all, so a « no budget » pick about a category that HAS
 * one would have been shown as true. `statements.spec.ts` covers the rule with period data it builds
 * itself, which is the step this suite does NOT perform: here the route's own reader builds it.
 *
 * Separates « budgets unknown on a partial period » from « the reader never read budgets at all »:
 * the same member, the same rows, on « this month », must read the budget as over.
 */
if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a ' +
			'server engine) to a throwaway database explicitly. It refuses to fall back to the ' +
			'default local SQLite file.'
	);
}
if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error(
		'DATABASE_URL points at dev.db, the default local development database. Point it at a ' +
			'throwaway database instead.'
	);
}

const createdUserIds: string[] = [];
const ENV = { LLM_ENABLED: 'true', LLM_MODEL: 'fake:996' } as NodeJS.ProcessEnv;

/** Today at 00:00 UTC: inside both « this month » and « last 30 days », whatever the date. */
function today(): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function seedMember(): Promise<string> {
	const user = await prisma.user.create({
		data: {
			email: `advice-facts-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(user.id);
	const account = await prisma.account.create({
		data: { ...DEFAULT_DENOMINATION, userId: user.id, name: 'Compte courant', source: 'manual' },
		select: { id: true }
	});
	const category = await prisma.category.create({
		data: { userId: user.id, name: 'Courses', nameKey: computeNameKey('Courses') },
		select: { id: true }
	});
	await prisma.monthlyBudget.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId: user.id,
			categoryName: 'Courses',
			categoryNameKey: computeNameKey('Courses'),
			amountCents: 1_000
		}
	});
	await prisma.transaction.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId: user.id,
			accountId: account.id,
			categoryId: category.id,
			date: today(),
			label: 'MARCHE COUVERT',
			amountCents: -4_520,
			type: 'expense',
			source: 'manual'
		}
	});
	return user.id;
}

async function factsFor(userId: string, period: string) {
	const periodData = await readDashboardPeriodData(
		userId,
		parseDateRange(new URLSearchParams({ period }))
	);
	return prepareAdvice({ periodData, includeLabels: false, env: ENV }).facts;
}

afterAll(async () => {
	for (const userId of createdUserIds) {
		await prisma.transaction.deleteMany({ where: { userId } });
		await prisma.category.deleteMany({ where: { userId } });
		await prisma.monthlyBudget.deleteMany({ where: { userId } });
		await prisma.account.deleteMany({ where: { userId } });
		await prisma.user.delete({ where: { id: userId } });
	}
});

describe('the facts an AI pick is checked against, read by the route’s own reader (#996)', () => {
	it('reads the budget on a whole month, and shows over_budget there', async () => {
		const userId = await seedMember();
		const facts = await factsFor(userId, 'this-month');
		expect(facts.categories).toEqual([
			{ alias: 'c1', name: 'Courses', amountCents: 4_520, budget: 'over_budget', recurring: false }
		]);
		expect(acceptPicks([{ kind: 'over_budget', category: 'c1' }], facts)).toEqual([
			{
				id: 'over_budget-c1',
				kind: 'over_budget',
				figures: [{ category: 'Courses', amountCents: 4_520 }]
			}
		]);
	});

	it('reads the budget as unknown on « last 30 days », and drops « no budget » there', async () => {
		const userId = await seedMember();
		const facts = await factsFor(userId, 'last-30-days');
		expect(facts.categories).toEqual([
			{ alias: 'c1', name: 'Courses', amountCents: 4_520, budget: 'unknown', recurring: false }
		]);
		expect(acceptPicks([{ kind: 'no_budget', category: 'c1' }], facts)).toBeNull();
	});
});
