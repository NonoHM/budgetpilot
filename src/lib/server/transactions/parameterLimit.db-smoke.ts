import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { collectAllTransactions } from './batch';
import { EFFECTIVE_CATEGORY_SELECT } from '$lib/server/transactions/nature';
import {
	spentCentsFor,
	readCurrentMonthSpending,
	readDashboardDataForRange
} from '$lib/server/budget/dashboard';
import { load as transactionsLoad } from '../../../routes/transactions/+page.server';
import { GET as exportGET } from '../../../routes/transactions/export/+server';
import { load as dashboardLoad } from '../../../routes/+page.server';
import { load as reportsLoad } from '../../../routes/reports/+page.server';

/**
 * THE SQLITE HOST-PARAMETER LIMIT, hit by EFFECTIVE_CATEGORY_SELECT's `splits` relation.
 *
 * `EFFECTIVE_CATEGORY_SELECT` (nature.ts) spreads a to-many `splits` select into every per-category
 * money read. Prisma resolves a to-many relation with a SECOND query carrying one host parameter
 * per parent row (`WHERE transactionId IN (?, ?, …)`), and SQLite refuses that query once its
 * parameter count is exceeded — a limit PostgreSQL and MariaDB do not share (32 767 and 65 535
 * host parameters respectively, against SQLite's low hundreds), which is why this defect shipped
 * past the whole cross-provider db-matrix and was only visible on SQLite, the default install.
 *
 * MEASURED (see batch.ts's own docstring for the reproduction): against this schema, on SQLite,
 * `findMany` with EFFECTIVE_CATEGORY_SELECT passes at `take=997` and fails at `take=998` with
 * `PrismaClientKnownRequestError: ... The query parameter limit supported by your database is
 * exceeded.` The identical select minus `splits` never failed up to `take=2000`.
 *
 * This suite seeds PAST that boundary — 1 100 transactions in each of two months, each carrying
 * one split, 2 200 rows total — and drives the fix through the SHARED primitive
 * (`collectAllTransactions`) and through every real call site the defect was originally measured
 * on: `/` , `/reports`, `/transactions` (the `?q=` scan branch) and `/transactions/export` (the
 * plain-scope branch). Per CLAUDE.md's "prove coexistence in the real artifact, not each part
 * alone", the point of driving the real `load`/`GET` functions rather than re-implementing their
 * queries is that a fix that only helps `collectAllTransactions` in isolation, while a route still
 * calls `prisma.transaction.findMany` directly, would leave every one of the four measured 500s
 * in place.
 *
 * BREAK-CHECK: reverting batch.ts's DEFAULT_BATCH_SIZE to 1000 (its pre-fix value, itself over the
 * measured 998-row boundary) turns every assertion below red with the real
 * `PrismaClientKnownRequestError` message quoted above — not a generic thrown error, the exact
 * database-reported one. Reverting the `readDashboardDataForRange`/`readCurrentMonthSpending` call
 * sites in dashboard.ts to a plain unbatched `prisma.transaction.findMany` (their pre-fix shape)
 * reproduces the same message independently of batch.ts's constant, which is why this suite drives
 * the call sites and not only the shared helper.
 *
 * See vitest.db.config.ts for how to run it.
 */

if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a server ' +
			'engine) to a throwaway database explicitly. It refuses to fall back to the default local ' +
			'SQLite file.'
	);
}

if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error(
		'DATABASE_URL points at dev.db, the default local development database. Point it at a ' +
			'throwaway database instead.'
	);
}

// Comfortably past BOTH the measured 998-row failure point and the pre-fix DEFAULT_BATCH_SIZE of
// 1000, in each of two months, so the fix is proven at a size neither number would have survived.
const ROWS_PER_MONTH = 1_100;

const createdUserIds: string[] = [];

function monthRange(monthOffset: number, now = new Date()) {
	const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1));
	const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset + 1, 1));
	return { from, to };
}

interface Seed {
	userId: string;
	accountId: string;
	categoryId: string;
}

async function seedUser(): Promise<Seed> {
	const user = await prisma.user.create({
		data: {
			email: `param-limit-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(user.id);

	const account = await prisma.account.create({
		data: { userId: user.id, name: 'Param limit smoke account', source: 'manual' },
		select: { id: true }
	});
	const categoryName = 'ParamLimit';
	const category = await prisma.category.create({
		data: { userId: user.id, name: categoryName, nameKey: computeNameKey(categoryName) },
		select: { id: true }
	});

	return { userId: user.id, accountId: account.id, categoryId: category.id };
}

/**
 * Seeds `count` unsplit-looking-but-actually-split transactions into the given month: one
 * TransactionSplit per transaction, its amount equal to the parent's, so `allocationsOf` resolves
 * a ZERO remainder — exactly one allocation per transaction, which is what makes the expected
 * counts below simple arithmetic instead of a restatement of the remainder rule.
 *
 * Writes go through `createMany`, never through `replaceSplits`: this suite is stressing a READ
 * boundary, and `replaceSplits`' own invariants (MIN_SPLITS_PER_TRANSACTION, sum-must-equal-parent
 * enforcement) are irrelevant to it — a direct write is the same shape every restore/import path in
 * this codebase already uses, and is far cheaper at this row count.
 */
async function seedMonth(seed: Seed, monthOffset: number, count: number): Promise<void> {
	const { from } = monthRange(monthOffset);
	// Scoped by userId as well as month offset: two `it` blocks each seed a "month 0", and ids are
	// unique across the whole table, not just within one user.
	const prefix = `param-limit-${seed.userId}-${monthOffset}-`;
	const CHUNK = 500;

	for (let start = 0; start < count; start += CHUNK) {
		const chunkSize = Math.min(CHUNK, count - start);
		await prisma.transaction.createMany({
			data: Array.from({ length: chunkSize }, (_, i) => {
				const index = start + i;
				return {
					id: `${prefix}${String(index).padStart(6, '0')}`,
					userId: seed.userId,
					accountId: seed.accountId,
					categoryId: seed.categoryId,
					date: from,
					label: `ParamLimit Row ${monthOffset}-${index}`,
					amountCents: -(1_000 + index),
					type: 'expense',
					source: 'csv'
				};
			})
		});
		await prisma.transactionSplit.createMany({
			data: Array.from({ length: chunkSize }, (_, i) => {
				const index = start + i;
				return {
					transactionId: `${prefix}${String(index).padStart(6, '0')}`,
					categoryId: seed.categoryId,
					amountCents: -(1_000 + index),
					position: 0
				};
			})
		});
	}
}

afterAll(async () => {
	for (const userId of createdUserIds) {
		// Transactions first, explicitly — see allocation.db-smoke.ts's afterAll for why: deleting a
		// User cascades into both Category and Transaction, and TransactionSplit is RESTRICT on
		// Category while it cascades from Transaction, so reaching Category first fails the whole
		// delete on PostgreSQL.
		await prisma.transaction.deleteMany({ where: { userId } });
		await prisma.user.delete({ where: { id: userId } });
	}
});

describe('EFFECTIVE_CATEGORY_SELECT past the SQLite parameter-limit boundary', () => {
	it('collectAllTransactions returns every row, with its split, past the boundary', async () => {
		const seed = await seedUser();
		await seedMonth(seed, 0, ROWS_PER_MONTH);

		const rows = await collectAllTransactions(
			{ userId: seed.userId },
			{
				id: true,
				amountCents: true,
				...EFFECTIVE_CATEGORY_SELECT
			}
		);

		expect(rows).toHaveLength(ROWS_PER_MONTH);
		expect(rows.every((row) => row.splits.length === 1)).toBe(true);
		// Every part's amount equals its parent's — a spot check that the join actually resolved the
		// right child rows rather than, say, an empty relation silently satisfying "length === 1".
		expect(rows.every((row) => row.splits[0].amountCents === row.amountCents)).toBe(true);
		// COUNTED BY DISTINCT ID, not by length. A cursor walk fails by repeating a row on one batch
		// and omitting another, and those two errors CANCEL in a length: the recorded paging incident
		// is precisely that shape, and the omission is the half that matters because the user simply
		// never sees a transaction they own.
		expect(new Set(rows.map((row) => row.id)).size).toBe(ROWS_PER_MONTH);
	}, 60_000);

	/**
	 * THE BATCHED WALK STILL BELONGS TO ONE USER, and until this test nothing in the suite could
	 * see otherwise: every other `it` seeds a fresh user into an otherwise empty table, so a
	 * `forEachTransactionBatch` that dropped its `where` entirely would have returned the same rows
	 * and every assertion would have stayed green. `batch.spec.ts`'s fake does not close it either —
	 * it discards `where` (`void where`) and models only the cursor.
	 *
	 * Two tenants, both past the boundary, so the walk has to survive several batches while another
	 * user's rows sit interleaved in the same table on the same dates.
	 */
	it('excludes a second tenant across every batch of the walk', async () => {
		const mine = await seedUser();
		const theirs = await seedUser();
		await seedMonth(mine, 0, ROWS_PER_MONTH);
		await seedMonth(theirs, 0, ROWS_PER_MONTH);

		const rows = await collectAllTransactions({ userId: mine.userId }, { id: true, userId: true });

		// THE TENANCY ASSERTION COMES FIRST, deliberately. Both orderings go red on a dropped `where`,
		// but a length assertion fails as « expected 3300 to have a length of 1100 », which reads like
		// a fixture that leaked; this one fails naming the rows that should not be there. A test on a
		// refusal asserts the REASON, and the reason is only the first assertion to run.
		expect(rows.filter((row) => row.userId !== mine.userId)).toEqual([]);
		expect(rows).toHaveLength(ROWS_PER_MONTH);
	}, 60_000);

	it('reaches every real call site the defect was measured on, past the boundary', async () => {
		const seed = await seedUser();
		await seedMonth(seed, 0, ROWS_PER_MONTH); // current month
		await seedMonth(seed, -1, ROWS_PER_MONTH); // previous month, for the reports comparison read

		const authUser = () =>
			({ id: seed.userId, email: 'param-limit@budgetpilot.invalid', role: 'USER' }) as never;

		// --- dashboard.ts's two direct call sites -------------------------------------------------
		const current = monthRange(0);
		const dashboardData = await readDashboardDataForRange(seed.userId, {
			...current,
			budgetMonth: 'param-limit-test'
		});
		expect(dashboardData.transactions).toHaveLength(ROWS_PER_MONTH);
		expect(dashboardData.allocations).toHaveLength(ROWS_PER_MONTH);

		const spendingByCategory = await readCurrentMonthSpending(seed.userId);
		const expectedSpendCents = ROWS_PER_MONTH * 1_000 + (ROWS_PER_MONTH * (ROWS_PER_MONTH - 1)) / 2;
		// Through `spentCentsFor`, never `.get()`. THIS LINE IS WHY THE KEY TYPE IS BRANDED. Written as
		// a raw `.get('ParamLimit')` on the branch this test was born on, it passed there — that branch's
		// map was still keyed raw — and failed the first time the two branches met, as
		// « expected undefined to be 1704450 », in a file about SQLite host parameters. Two green PRs,
		// red together: the first standing principle in CLAUDE.md. It is now a compile error instead.
		expect(spentCentsFor(spendingByCategory, 'ParamLimit')).toBe(expectedSpendCents);

		// --- /transactions, the `?q=` SCAN branch (scope.collect -> forEachTransactionBatch) -------
		const listResult = (await transactionsLoad({
			locals: { user: authUser() },
			url: new URL('http://localhost/transactions?q=ParamLimit&page=1')
		} as never)) as { pagination: { totalTransactions: number } };
		expect(listResult.pagination.totalTransactions).toBe(ROWS_PER_MONTH * 2);

		// --- /transactions/export, the plain-scope (non-scan) branch --------------------------------
		const exportResponse = (await exportGET({
			locals: { user: authUser() },
			url: new URL('http://localhost/transactions/export')
		} as never)) as Response;
		const csvLines = (await exportResponse.text()).trim().split('\r\n');
		// One header line, then one line per allocation. Each transaction here yields exactly one
		// allocation (its single split covers the whole amount, remainder zero), so the count is the
		// same arithmetic as the dashboard assertion above, doubled for the two seeded months.
		expect(csvLines.length - 1).toBe(ROWS_PER_MONTH * 2);

		// --- /, the dashboard route (also exercises loadDashboardInsights' history-month reads and
		// loadCashFlowForecast's/loadUpcomingBillsWidget's own 12-month readDashboardDataForRange) ---
		const dashboardPage = (await dashboardLoad({
			locals: { user: authUser() },
			url: new URL('http://localhost/')
		} as never)) as { transactions: unknown[] };
		expect(dashboardPage.transactions).toHaveLength(ROWS_PER_MONTH);

		// --- /reports, the default "this month" period (exercises readTransactionsForRange over the
		// PREVIOUS month, the one unbounded findMany reports/+page.server.ts carried before the fix) -
		const reportsPage = (await reportsLoad({
			locals: { user: authUser() },
			url: new URL('http://localhost/reports')
		} as never)) as {
			report: {
				transactionCount: number;
				previousMonth?: { expenseDeltaCents: number };
			};
		};
		expect(reportsPage.report.transactionCount).toBe(ROWS_PER_MONTH);
		// THE PREVIOUS-MONTH FIGURE, not just the page not throwing. `report.transactionCount` above
		// is derived from the CURRENT month's `readDashboardDataForRange`, so it says nothing at all
		// about `readTransactionsForRange` — the one read on this page that walks ASCENDING, and the
		// one this PR converted last. Without an assertion that reaches it, a defect specific to the
		// 'asc' cursor direction (a row dropped or repeated under a date tie, and all 1 100 rows here
		// share one date) would pass the whole suite, because the only thing proven about that call
		// would be that it returned.
		//
		// It surfaces as a DELTA rather than as a count: the load hands the previous period into
		// `buildPeriodReport`, which keeps only the differences. Both months hold the identical 1 100
		// rows with the identical amounts, so the delta is exactly zero — and a single row lost or
		// repeated by the ascending walk moves it off zero by that row's amount.
		expect(reportsPage.report.previousMonth?.expenseDeltaCents).toBe(0);
	}, 60_000);
});
