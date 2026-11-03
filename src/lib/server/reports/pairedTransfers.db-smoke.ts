import { env } from '$env/dynamic/private';
import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { confirmTransferPair } from '$lib/server/transactions/transferPairs';
import { load as reportsLoad } from '../../../routes/reports/+page.server';
import { load as dashboardLoad } from '../../../routes/+page.server';
import { load as transactionsLoad } from '../../../routes/transactions/+page.server';

// #212 (R3 v2 on #1193): a CONFIRMED pair leaves the income and expense figures, each leg in its
// own period; an unpaired row stays counted. Every figure is read through the route `load` a
// member's browser calls, before and after the pair is confirmed on the same rows, so the only
// difference between the two reads is the stored link.

env.RATE_LIMIT_HASH_SECRET = 'a9'.repeat(32);

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

const PAIR_CENTS = 50_000;
const createdUserIds: string[] = [];

afterAll(async () => {
	if (createdUserIds.length > 0) {
		await prisma.transaction.deleteMany({ where: { userId: { in: createdUserIds } } });
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
});

interface Seed {
	userId: string;
	checking: string;
	savings: string;
	categories: Record<string, string>;
}

async function seed(): Promise<Seed> {
	const { id: userId } = await prisma.user.create({
		data: {
			email: `paired-totals-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(userId);
	const [checking, savings] = await Promise.all(
		['Compte courant', 'Livret A'].map((name) =>
			prisma.account.create({
				data: { ...DEFAULT_DENOMINATION, userId, name, nameKey: computeNameKey(name), source: 'csv' },
				select: { id: true }
			})
		)
	);
	const categories: Record<string, string> = {};
	for (const name of ['Salaire', 'Courses', 'Épargne', 'Divers']) {
		const created = await prisma.category.create({
			data: { userId, name, nameKey: computeNameKey(name) },
			select: { id: true }
		});
		categories[name] = created.id;
	}
	// Section 0 of the 1.4 plan: the outgoing leg matches a savings mapping (nature `transfer`)
	// while the incoming leg falls back by sign to `income`.
	await prisma.categoryNatureMapping.create({
		data: { userId, categoryName: 'Épargne', categoryNameKey: computeNameKey('Épargne'), nature: 'transfer' }
	});
	return { userId, checking: checking.id, savings: savings.id, categories };
}

/** Stored as `server/import/persist.ts` writes a row: a magnitude, the direction in `type`. */
async function row(
	s: Seed,
	accountId: string,
	type: 'income' | 'expense',
	date: string,
	amountCents: number,
	category: string,
	label: string
): Promise<string> {
	const created = await prisma.transaction.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId: s.userId,
			accountId,
			categoryId: s.categories[category],
			date: new Date(`${date}T00:00:00.000Z`),
			label,
			amountCents: BigInt(amountCents),
			type,
			source: 'csv'
		},
		select: { id: true }
	});
	return created.id;
}

/** The ordinary month around a pair: one salary, one grocery run. */
async function ordinaryMonth(s: Seed, month: string): Promise<void> {
	await row(s, s.checking, 'income', `${month}-02`, 300_000, 'Salaire', 'VIREMENT SALAIRE');
	await row(s, s.checking, 'expense', `${month}-05`, 40_000, 'Courses', 'CB SUPERMARCHE');
}

async function pairRows(s: Seed, outDate: string, inDate: string): Promise<[string, string]> {
	const out = await row(s, s.checking, 'expense', outDate, PAIR_CENTS, 'Épargne', 'VIR SEPA LIVRET A');
	const into = await row(s, s.savings, 'income', inDate, PAIR_CENTS, 'Divers', 'VIREMENT RECU');
	return [out, into];
}

function event(userId: string, path: string) {
	return {
		locals: { user: { id: userId, email: 'paired@budgetpilot.invalid', role: 'USER' } },
		url: new URL(`http://localhost${path}`)
	} as never;
}

const customMonth = (month: string, lastDay: number) =>
	`?period=custom&from=${month}-01&to=${month}-${String(lastDay).padStart(2, '0')}`;

interface ReportFigures {
	incomeCents: number;
	expenseCents: number;
	balanceCents: number;
	savingsRate: number | null;
	linkedTransferCount: number;
	transactionCount: number;
	expenseAveragePerDayCents: number;
	topCategories: Array<{ category: string; amountCents: number; percentageOfExpenses: number }>;
	largestExpenses: Array<{ label: string; amountCents: number }>;
	natureAnalysis: { incomeCents: number; spendingCents: number; transferCents: number };
	previousMonth?: { incomeDeltaCents: number; expenseDeltaCents: number; balanceDeltaCents: number };
}

async function report(userId: string, query: string): Promise<ReportFigures> {
	const data = (await reportsLoad(event(userId, `/reports${query}`))) as { report: ReportFigures };
	return data.report;
}

async function dashboard(userId: string, query: string) {
	return (await dashboardLoad(event(userId, `/${query}`))) as {
		summary: { incomeCents: number; expenseCents: number; balanceCents: number };
		natureAnalysis: { incomeCents: number; transferCents: number };
		linkedTransferCount: number;
	};
}

describe('a confirmed pair inside one period, on /reports', () => {
	it('lowers income and expense by the pair and leaves the balance identical', async () => {
		const s = await seed();
		await ordinaryMonth(s, '2026-03');
		const [out, into] = await pairRows(s, '2026-03-10', '2026-03-12');
		const before = await report(s.userId, customMonth('2026-03', 31));

		expect(await confirmTransferPair(s.userId, out, into)).toEqual({ ok: true });
		const after = await report(s.userId, customMonth('2026-03', 31));

		// Calibration: the read before the link counts both legs at full size.
		expect([before.incomeCents, before.expenseCents]).toEqual([350_000, 90_000]);
		expect([after.incomeCents, after.expenseCents]).toEqual([300_000, 40_000]);
		expect(after.balanceCents).toBe(before.balanceCents);
		expect(after.savingsRate).toBe(260_000 / 300_000);
		// The screen sentence's trigger, and the bank-line count that does not move.
		expect([before.linkedTransferCount, after.linkedTransferCount]).toEqual([0, 2]);
		expect(after.transactionCount).toBe(before.transactionCount);
	});

	it('takes the pair out of every expense-derived list beside the total', async () => {
		const s = await seed();
		await ordinaryMonth(s, '2026-03');
		const [out, into] = await pairRows(s, '2026-03-10', '2026-03-12');
		await confirmTransferPair(s.userId, out, into);

		const after = await report(s.userId, customMonth('2026-03', 31));

		expect(after.topCategories.map((c) => [c.category, c.amountCents, c.percentageOfExpenses])).toEqual([
			['Courses', 40_000, 1]
		]);
		expect(after.largestExpenses.map((e) => e.amountCents)).toEqual([40_000]);
		expect(after.expenseAveragePerDayCents).toBe(Math.round(40_000 / 31));
		expect(after.natureAnalysis.transferCents).toBe(0);
		expect(after.natureAnalysis.incomeCents).toBe(300_000);
	});
});

describe('a confirmed pair whose legs straddle two periods', () => {
	it('loses its own leg in each period, and the two balances sum to the same figure', async () => {
		const s = await seed();
		await ordinaryMonth(s, '2026-03');
		await ordinaryMonth(s, '2026-04');
		const [out, into] = await pairRows(s, '2026-03-30', '2026-04-01');
		const marchBefore = await report(s.userId, customMonth('2026-03', 31));
		const aprilBefore = await report(s.userId, customMonth('2026-04', 30));

		await confirmTransferPair(s.userId, out, into);
		const march = await report(s.userId, customMonth('2026-03', 31));
		const april = await report(s.userId, customMonth('2026-04', 30));

		expect([march.incomeCents, march.expenseCents]).toEqual([300_000, 40_000]);
		expect([april.incomeCents, april.expenseCents]).toEqual([300_000, 40_000]);
		expect([march.linkedTransferCount, april.linkedTransferCount]).toEqual([1, 1]);
		expect(march.balanceCents + april.balanceCents).toBe(
			marchBefore.balanceCents + aprilBefore.balanceCents
		);
	});
});

describe('the comparison period on /reports', () => {
	it('leaves the pair out of the previous month it compares against', async () => {
		const s = await seed();
		const now = new Date();
		const month = (offset: number) => {
			const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
			return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
		};
		await ordinaryMonth(s, month(-1));
		await ordinaryMonth(s, month(0));
		const [out, into] = await pairRows(s, `${month(-1)}-10`, `${month(-1)}-12`);
		await confirmTransferPair(s.userId, out, into);

		const current = await report(s.userId, '?period=this-month');

		// Both months hold the same ordinary rows, so with the pair left out every delta is 0.
		expect(current.previousMonth).toMatchObject({
			incomeDeltaCents: 0,
			expenseDeltaCents: 0,
			balanceDeltaCents: 0
		});
	});
});

describe('a confirmed pair on the dashboard', () => {
	it('lowers the income and expense tiles by the pair and leaves the balance identical', async () => {
		const s = await seed();
		await ordinaryMonth(s, '2026-03');
		const [out, into] = await pairRows(s, '2026-03-10', '2026-03-12');
		const before = await dashboard(s.userId, customMonth('2026-03', 31));

		await confirmTransferPair(s.userId, out, into);
		const after = await dashboard(s.userId, customMonth('2026-03', 31));

		expect([before.summary.incomeCents, before.summary.expenseCents]).toEqual([350_000, 90_000]);
		expect([after.summary.incomeCents, after.summary.expenseCents]).toEqual([300_000, 40_000]);
		expect(after.summary.balanceCents).toBe(before.summary.balanceCents);
		expect([after.natureAnalysis.incomeCents, after.natureAnalysis.transferCents]).toEqual([
			300_000, 0
		]);
		expect([before.linkedTransferCount, after.linkedTransferCount]).toEqual([0, 2]);
	});
});

describe('rows that are NOT a confirmed pair', () => {
	it('stay counted at full size, whatever nature each leg resolves to (section 0)', async () => {
		const s = await seed();
		await ordinaryMonth(s, '2026-03');
		await pairRows(s, '2026-03-10', '2026-03-12');

		const unpaired = await report(s.userId, customMonth('2026-03', 31));

		expect([unpaired.incomeCents, unpaired.expenseCents]).toEqual([350_000, 90_000]);
		expect(unpaired.natureAnalysis.transferCents).toBe(PAIR_CENTS);
	});
});

describe('figures left unchanged by recorded decision', () => {
	it('keeps the /transactions band a sum of the listed rows, pair included', async () => {
		const s = await seed();
		await ordinaryMonth(s, '2026-03');
		const [out, into] = await pairRows(s, '2026-03-10', '2026-03-12');
		await confirmTransferPair(s.userId, out, into);

		const data = (await transactionsLoad(
			event(s.userId, `/transactions${customMonth('2026-03', 31)}`)
		)) as { filteredTotals: { incomeCents: number; expenseCents: number } };

		expect(data.filteredTotals).toEqual({ incomeCents: 350_000, expenseCents: 90_000 });
	});

	it('keeps a budget on the leg category counting the leg, on the dashboard beside the tiles', async () => {
		// An explicit budget counts every expense in its category (domain/budget.ts,
		// shouldCountAllocationForBudget), which is how a member tracks a savings target; the
		// /budgets figure reads the same rule, so the two keep agreeing.
		const s = await seed();
		await ordinaryMonth(s, '2026-03');
		await prisma.monthlyBudget.create({
			data: {
				...DEFAULT_DENOMINATION,
				userId: s.userId,
				categoryName: 'Épargne',
				categoryNameKey: computeNameKey('Épargne'),
				amountCents: BigInt(60_000)
			}
		});
		const [out, into] = await pairRows(s, '2026-03-10', '2026-03-12');
		await confirmTransferPair(s.userId, out, into);

		const data = (await dashboardLoad(event(s.userId, `/${customMonth('2026-03', 31)}`))) as {
			summary: { categorySummaries: Array<{ category: string; spentCents: number }> };
		};

		expect(data.summary.categorySummaries.map((b) => [b.category, b.spentCents])).toEqual([
			['Épargne', PAIR_CENTS]
		]);
	});
});
