import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { readDashboardPeriodData } from '$lib/server/dashboard/periodData';
import { parseDateRange } from '$lib/server/date-range';
import { prepareAdvice } from './gateway';
import { acceptPicks } from './statements';
import { manualCategoryUpdate } from '$lib/server/transactions/manualCategory';

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

/**
 * Contradiction pass F1 on the final code: two stored spellings of one category. Budget spending is
 * summed per FOLDED name (`domain/budget.ts`), the top categories per RAW name
 * (`reports/monthly.ts`), so « Courses » and « courses » are one budget and two top lines. A verdict
 * on the budget beside the figure of one spelling reads « Over budget, Courses 300,00 € » under a
 * 400,00 € limit, and the ranking of top categories is not the folded one. Restore and the category
 * rules both store a name as written, so the shape is reachable.
 */
async function seedTwoSpellings(): Promise<string> {
	const userId = await seedMember();
	const account = await prisma.account.findFirstOrThrow({
		where: { userId },
		select: { id: true }
	});
	const courses = await prisma.category.findFirstOrThrow({
		where: { userId, name: 'Courses' },
		select: { id: true }
	});
	const logement = await prisma.category.create({
		data: { userId, name: 'Logement', nameKey: computeNameKey('Logement') },
		select: { id: true }
	});
	await prisma.monthlyBudget.updateMany({ where: { userId }, data: { amountCents: 40_000 } });
	await prisma.transaction.deleteMany({ where: { userId } });
	const row = {
		...DEFAULT_DENOMINATION,
		userId,
		accountId: account.id,
		date: today(),
		type: 'expense',
		source: 'manual'
	} as const;
	for (const data of [
		{ ...row, categoryId: courses.id, label: 'MARCHE COUVERT', amountCents: -30_000 },
		{
			...row,
			label: 'EPICERIE',
			amountCents: -25_000,
			categoryId: courses.id,
			// How restore and the category rules store it: as written, with its key.
			...manualCategoryUpdate('courses')
		},
		{ ...row, categoryId: logement.id, label: 'BAILLEUR', amountCents: -50_000 }
	])
		await prisma.transaction.create({ data });
	return userId;
}

describe('the facts an AI pick is checked against, read by the route’s own reader (#996)', () => {
	it('shows no budget verdict and no top category where two spellings fold to one category', async () => {
		const userId = await seedTwoSpellings();
		const facts = await factsFor(userId, 'this-month');
		// The measured shape first: three raw lines, the budget over on the folded total.
		expect(facts.categories.map((category) => [category.name, category.amountCents])).toEqual([
			['Logement', 50_000],
			['Courses', 30_000],
			['courses', 25_000]
		]);
		const aliases = Object.fromEntries(facts.categories.map((c) => [c.name, c.alias]));
		expect(
			acceptPicks(
				[
					{ kind: 'over_budget', category: aliases.Courses },
					{ kind: 'over_budget', category: aliases.courses },
					{ kind: 'top_category', category: aliases.Logement }
				],
				facts
			)
		).toBeNull();
	});

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
