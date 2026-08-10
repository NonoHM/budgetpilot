import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import type { CategoryAllocation } from '$lib/domain/allocation';
import type { CategoryBudget } from '$lib/domain/budget';
import { summarizeBudgetAllocations } from '$lib/domain/budget';
import { readCurrentMonthSpending, readDashboardDataForRange } from '$lib/server/budget/dashboard';
import type { CategorySpending } from '$lib/server/budget/dashboard';
import { spendByEffectiveCategory } from '$lib/server/dashboard/insights';
import { analyzeTransactionNatures } from '$lib/server/transactions/nature';
import { buildPeriodReport, getTopCategories } from '$lib/server/reports/monthly';
import { replaceSplits } from './splits';
import type { Transaction } from '$lib/domain/transaction';

/**
 * THE ANTI-DOUBLE-COUNT GUARD — the central protection of the split-transactions work.
 *
 * A répartition is the one change in this application that can make the same euro appear twice.
 * The parent row keeps its full amount and its own category, deliberately, so any per-category read
 * that adds a transaction's amount to its parts' amounts reports double. That figure is not a crash
 * and not a visibly silly number: it is a plausible total, on a screen made of plausible totals.
 *
 * What is asserted, and why in this form:
 *
 *  1. CONSERVATION, per transaction and in aggregate. Σ of a transaction's allocations equals that
 *     transaction's own `amountCents`. Both sides are read from the database — the expected value
 *     comes from an independent `findMany` on the parent column, never from the same aggregation
 *     being checked, and never from a literal in this file.
 *
 *  2. COVERAGE. Every allocation belongs to exactly one transaction that exists, and every
 *     transaction is covered at least once. The generalisation of totals.db-smoke.ts' "no row is
 *     counted twice, and none is dropped" from a two-bucket predicate to an N-part fan-out.
 *
 *  3. EVERY MONEY SITE AGREES with the same conserved figure. This is the assertion that fails when
 *     a site is written against `Transaction.amountCents` after parts exist. Each entry in
 *     MONEY_SITES derives its number from the site's OWN return value; nothing is restated.
 *
 * WHY THIS RUNS PER ENGINE rather than as a unit test: the allocations come out of Prisma's nested
 * `splits` select, ordered by `position`, joined per row. A fake Prisma returns whatever the fixture
 * says, which is to say it returns the answer instead of testing the query that produces it — the
 * same reason CLAUDE.md gives under "Unit tests cannot see a wrong SQL predicate".
 *
 * WHAT THIS CANNOT DO, stated so nobody deletes the tests that can: an agreement test proves the
 * sites agree, never that any of them is RIGHT. A defect in the shared remainder rule moves all of
 * them identically and they go on agreeing. The absolute pairings are `distributeEvenly`'s matrix in
 * allocation.spec.ts and `replaceSplits`' validator against each forged payload in
 * splits.db-smoke.ts. "The conservation guard covers it" is not a reason to drop either.
 *
 * See vitest.db.config.ts for how to run it.
 */

// Same refusal as splits.db-smoke.ts, for the same reason: the app's client falls back to
// `file:./dev.db`, a developer's real local database, and this suite creates and deletes rows.
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

/**
 * THE CANONICAL RÉPARTITION: 80,00 € split 60/20.
 *
 * These three constants exist so the break-the-check has an unambiguous figure to reproduce. Make
 * any money site add the parent's amount to its parts' and it reports 160,00 € — 16 000 centimes —
 * where it must report 8 000. A red run that merely says "mismatch" has verified nothing; the
 * acceptance bar is that exact doubling, named site by site.
 *
 * No assertion below compares against them. They are the SEED, never the expected value: what the
 * assertions compare against is read back out of the database.
 */
const CANONICAL_PARENT_CENTS = -8_000;
const CANONICAL_FIRST_PART_CENTS = -6_000;
const CANONICAL_SECOND_PART_CENTS = -2_000;

/**
 * The current UTC month, because `readCurrentMonthSpending` reads the wall clock internally and
 * cannot be pinned by an argument (see its docstring). Every other read here takes this same range,
 * so all the sites are looking at one set of rows.
 *
 * The residual hazard, recorded rather than engineered around: a run that crosses UTC midnight on
 * the last day of a month would seed into one month and read the next. Check `date -u` if this
 * suite ever fails on the 1st with an empty result.
 */
function currentMonthRange() {
	const now = new Date();
	return {
		from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
		to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
		budgetMonth: `${now.getUTCFullYear()}-${`${now.getUTCMonth() + 1}`.padStart(2, '0')}`,
		day: (dayOfMonth: number) =>
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), dayOfMonth))
	};
}

interface Seed {
	userId: string;
	accountId: string;
	categoryIds: Record<string, string>;
}

async function seedUser(categoryNames: string[]): Promise<Seed> {
	const user = await prisma.user.create({
		data: {
			email: `allocation-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
			// Not a hash of anything, and never used to authenticate: nothing in this suite logs in.
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(user.id);

	const account = await prisma.account.create({
		data: { userId: user.id, name: 'Compte courant', source: 'manual' },
		select: { id: true }
	});

	const categoryIds: Record<string, string> = {};
	for (const name of categoryNames) {
		const category = await prisma.category.create({
			data: { userId: user.id, name, nameKey: computeNameKey(name) },
			select: { id: true }
		});
		categoryIds[name] = category.id;
	}

	return { userId: user.id, accountId: account.id, categoryIds };
}

/**
 * `type` is written explicitly rather than left to the sign, and that is not incidental.
 * `readCurrentMonthSpending` filters `type: 'expense'` in SQL while every other money read falls
 * back to the sign — a divergence recorded in CLAUDE.md's backlog. A fixture that leaves `type`
 * null would be invisible to exactly one of the sites swept below, and this suite would report the
 * divergence as a double-count defect it is not.
 */
async function createTransaction(
	seed: Seed,
	input: { label: string; amountCents: number; category: string; dayOfMonth: number }
): Promise<string> {
	const month = currentMonthRange();
	const transaction = await prisma.transaction.create({
		data: {
			userId: seed.userId,
			accountId: seed.accountId,
			categoryId: seed.categoryIds[input.category],
			date: month.day(input.dayOfMonth),
			label: input.label,
			amountCents: input.amountCents,
			type: input.amountCents >= 0 ? 'income' : 'expense',
			source: 'manual'
		},
		select: { id: true }
	});
	return transaction.id;
}

/** The view every money site is evaluated against, so they all read one set of rows. */
interface MoneyView {
	transactions: Transaction[];
	allocations: CategoryAllocation[];
	budgets: CategoryBudget[];
	period: string;
	currentMonthSpending: CategorySpending;
}

/**
 * Every site that turns money into a per-category or per-nature figure, each reporting its own
 * total expense in centimes, derived from what that site actually returned.
 *
 * The list is the blast-radius table made executable. A new aggregation added later belongs here;
 * if its total cannot be expressed as a number, that is a finding rather than a reason to omit it.
 */
const MONEY_SITES: Array<{ name: string; totalExpenseCents: (view: MoneyView) => number }> = [
	{
		name: 'readDashboardDataForRange.allocations',
		totalExpenseCents: (view) =>
			view.allocations
				.filter((allocation) => allocation.kind === 'expense')
				.reduce((total, allocation) => total + Math.abs(allocation.amountCents), 0)
	},
	{
		name: 'summarizeBudgetAllocations',
		totalExpenseCents: (view) =>
			summarizeBudgetAllocations(view.allocations, view.budgets, view.period).expenseCents
	},
	{
		name: 'spendByEffectiveCategory',
		totalExpenseCents: (view) =>
			[...spendByEffectiveCategory(view.allocations).values()].reduce(
				(total, cents) => total + cents,
				0
			)
	},
	{
		name: 'analyzeTransactionNatures',
		totalExpenseCents: (view) => {
			const analysis = analyzeTransactionNatures(view.allocations);
			// Every expense-side bucket, summed. `incomeCents` is deliberately excluded — it is the
			// only bucket fed by income allocations.
			return (
				analysis.spendingCents +
				analysis.investmentCents +
				analysis.transferCents +
				analysis.refundCents +
				analysis.feeCents +
				analysis.uncategorizedCents
			);
		}
	},
	{
		name: 'buildPeriodReport.expenseCents',
		totalExpenseCents: (view) =>
			buildPeriodReport(view.transactions, view.allocations, view.period).expenseCents
	},
	{
		name: 'buildPeriodReport.topCategories',
		totalExpenseCents: (view) =>
			buildPeriodReport(view.transactions, view.allocations, view.period).topCategories.reduce(
				(total, category) => total + category.amountCents,
				0
			)
	},
	{
		name: 'getTopCategories',
		totalExpenseCents: (view) =>
			getTopCategories(
				view.allocations.filter((allocation) => allocation.kind === 'expense')
			).reduce((total, category) => total + category.amountCents, 0)
	},
	{
		name: 'readCurrentMonthSpending',
		totalExpenseCents: (view) =>
			[...view.currentMonthSpending.values()].reduce((total, cents) => total + cents, 0)
	}
];

async function readMoneyView(userId: string): Promise<MoneyView> {
	const month = currentMonthRange();
	const data = await readDashboardDataForRange(userId, month);
	return {
		transactions: data.transactions,
		allocations: data.allocations,
		budgets: data.budgets,
		period: month.budgetMonth,
		currentMonthSpending: await readCurrentMonthSpending(userId)
	};
}

/** The parent amounts, read straight off the column — the one figure in this file that does not
 *  come through the aggregation under test. */
async function readParentAmounts(userId: string): Promise<Map<string, number>> {
	const rows = await prisma.transaction.findMany({
		where: { userId },
		select: { id: true, amountCents: true }
	});
	return new Map(rows.map((row) => [row.id, row.amountCents]));
}

afterAll(async () => {
	for (const userId of createdUserIds) {
		// Transactions first, explicitly. Deleting a User cascades into both Category and
		// Transaction, and TransactionSplit is RESTRICT on Category while it cascades from
		// Transaction — reach Category first and the whole delete fails. Provider-divergent: this
		// passes on SQLite and MySQL either way and fails on PostgreSQL.
		await prisma.transaction.deleteMany({ where: { userId } });
		await prisma.user.delete({ where: { id: userId } });
	}
});

describe('the anti-double-count guard', () => {
	it('reports the parent amount ONCE at every money site, for the canonical 60/20 répartition', async () => {
		const seed = await seedUser(['Maison', 'Alimentation', 'Loisirs']);
		const transactionId = await createTransaction(seed, {
			label: 'Achat mixte',
			amountCents: CANONICAL_PARENT_CENTS,
			category: 'Maison',
			dayOfMonth: 5
		});

		const written = await replaceSplits(seed.userId, transactionId, [
			{ categoryId: seed.categoryIds['Alimentation'], amountCents: CANONICAL_FIRST_PART_CENTS },
			{ categoryId: seed.categoryIds['Loisirs'], amountCents: CANONICAL_SECOND_PART_CENTS }
		]);
		expect(written).toEqual({ ok: true });

		// The expected figure comes from the parent column, not from this file and not from any
		// aggregation being checked. It is the whole reason a broken site reports exactly double it.
		const parentAmounts = await readParentAmounts(seed.userId);
		const expectedCents = Math.abs(parentAmounts.get(transactionId) ?? 0);
		expect(expectedCents).toBeGreaterThan(0);

		const view = await readMoneyView(seed.userId);

		for (const site of MONEY_SITES) {
			// Reported as an object so a failure names the SITE alongside both figures. A bare
			// numeric mismatch is what makes a break-the-check unreadable.
			expect({ site: site.name, cents: site.totalExpenseCents(view) }).toEqual({
				site: site.name,
				cents: expectedCents
			});
		}

		// Two parts, no remainder — proven, not assumed, because a répartition that failed to write
		// would leave one allocation and every site would agree on the parent's amount for the wrong
		// reason.
		//
		// It sits AFTER the sweep on purpose. Placed before it, this shape assertion fires first when
		// the remainder rule is broken and the run reports "expected length 2, got 3" — true, and
		// useless as evidence. The whole acceptance bar for breaking this check is that it reproduces
		// the FIGURE, 8 000 becoming 16 000, so the money assertions have to be the ones that speak.
		expect(view.allocations).toHaveLength(2);
	}, 60_000);

	it('conserves every transaction total across its allocations, over a mixed period', async () => {
		const seed = await seedUser(['Maison', 'Alimentation', 'Loisirs', 'Revenus']);

		const splitId = await createTransaction(seed, {
			label: 'Achat mixte',
			amountCents: CANONICAL_PARENT_CENTS,
			category: 'Maison',
			dayOfMonth: 6
		});
		await replaceSplits(seed.userId, splitId, [
			{ categoryId: seed.categoryIds['Alimentation'], amountCents: CANONICAL_FIRST_PART_CENTS },
			{ categoryId: seed.categoryIds['Loisirs'], amountCents: CANONICAL_SECOND_PART_CENTS }
		]);

		// Two parts in ONE category. Legal by design, and the case a naive de-duplication by category
		// would silently collapse into one.
		const twiceId = await createTransaction(seed, {
			label: 'Deux courses le meme jour',
			amountCents: -5_000,
			category: 'Maison',
			dayOfMonth: 7
		});
		await replaceSplits(seed.userId, twiceId, [
			{ categoryId: seed.categoryIds['Alimentation'], amountCents: -3_000 },
			{ categoryId: seed.categoryIds['Alimentation'], amountCents: -2_000 }
		]);

		const unsplitId = await createTransaction(seed, {
			label: 'Loyer',
			amountCents: -1_500,
			category: 'Maison',
			dayOfMonth: 8
		});
		const incomeId = await createTransaction(seed, {
			label: 'Salaire',
			amountCents: 250_000,
			category: 'Revenus',
			dayOfMonth: 2
		});

		// The parent's amount moved out from under its parts AFTER they were written. `replaceSplits`
		// cannot produce this state — it re-reads the parent inside the transaction and refuses a sum
		// that disagrees — but an edit to the parent's amount can, and a restored backup could. It is
		// the branch that makes conservation TOTAL rather than merely usually true: `allocationsOf`
		// emits the difference as a remainder under the parent's own category.
		const driftedId = await createTransaction(seed, {
			label: 'Montant deplace',
			amountCents: -4_000,
			category: 'Maison',
			dayOfMonth: 9
		});
		await replaceSplits(seed.userId, driftedId, [
			{ categoryId: seed.categoryIds['Alimentation'], amountCents: -3_000 },
			{ categoryId: seed.categoryIds['Loisirs'], amountCents: -1_000 }
		]);
		await prisma.transaction.update({
			where: { id: driftedId },
			data: { amountCents: -6_000 }
		});

		const parentAmounts = await readParentAmounts(seed.userId);
		const view = await readMoneyView(seed.userId);

		// ---- 1. CONSERVATION, per transaction ------------------------------------------------
		const allocatedByTransaction = new Map<string, number>();
		for (const allocation of view.allocations) {
			allocatedByTransaction.set(
				allocation.transactionId,
				(allocatedByTransaction.get(allocation.transactionId) ?? 0) + allocation.amountCents
			);
		}
		expect(Object.fromEntries(allocatedByTransaction)).toEqual(Object.fromEntries(parentAmounts));

		// ---- 2. COVERAGE ---------------------------------------------------------------------
		// Signed, not absolute. Conservation is a statement about signed amounts; the absolute sum
		// happens to agree for every row in this fixture, including the drifted one (its parent grew,
		// so its remainder carries the same sign as its parts). A parent that SHRANK below its parts
		// would produce an opposite-signed remainder, which conserves signed and inflates absolute —
		// deliberately not seeded here, because absolute inflation is a property of `Math.abs` at the
		// display sites rather than a failure of this guard, and mixing the two would make a red run
		// ambiguous.
		const allocationTotal = view.allocations.reduce(
			(total, allocation) => total + allocation.amountCents,
			0
		);
		const transactionTotal = view.transactions.reduce(
			(total, transaction) => total + transaction.amountCents,
			0
		);
		expect(allocationTotal).toBe(transactionTotal);

		// Every allocation belongs to a transaction that exists, and every transaction is covered.
		expect([...allocatedByTransaction.keys()].sort()).toEqual(
			view.transactions.map((transaction) => transaction.id).sort()
		);
		expect([splitId, twiceId, unsplitId, incomeId, driftedId].sort()).toEqual(
			view.transactions.map((transaction) => transaction.id).sort()
		);

		// The fan-out is real: five transactions, more than five allocations. Without this the two
		// assertions above would pass on a boundary that emitted no parts at all.
		expect(view.allocations.length).toBeGreaterThan(view.transactions.length);

		// ---- 3. EVERY MONEY SITE AGREES ------------------------------------------------------
		// `getTopCategories` returns the top five, so its total is the period's total only while the
		// fixture has at most five expense categories. Asserted rather than assumed: adding a sixth
		// later would silently turn one of the sites below into an under-report that reads as a
		// double-count defect elsewhere.
		const expenseCategories = new Set(
			view.allocations
				.filter((allocation) => allocation.kind === 'expense')
				.map((allocation) => allocation.category)
		);
		expect(expenseCategories.size).toBeLessThanOrEqual(5);

		const expectedExpenseCents = view.allocations
			.filter((allocation) => allocation.kind === 'expense')
			.reduce((total, allocation) => total + Math.abs(allocation.amountCents), 0);

		for (const site of MONEY_SITES) {
			expect({ site: site.name, cents: site.totalExpenseCents(view) }).toEqual({
				site: site.name,
				cents: expectedExpenseCents
			});
		}
	}, 60_000);
});
