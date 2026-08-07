import type { Prisma } from '../database/types.ts';
import { getTransactionKind, type TransactionKind } from '$lib/domain/transaction';
import { allocateByCategory } from '$lib/domain/allocation';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { getEffectiveCategory } from '$lib/server/transactions/nature';
import { prisma } from '$lib/server/db';

/**
 * The one place the app turns a stored row into income-or-expense.
 *
 * This function existed twice, byte-identically and privately, in routes/transactions/+page.server.ts
 * and routes/transactions/export/+server.ts, plus as an inlined ternary in at least three more
 * places. Both copies are now imports of this one.
 */
export function resolveTransactionType(transaction: {
	amountCents: number;
	type: string | null;
}): TransactionKind {
	return getTransactionKind({
		amountCents: transaction.amountCents,
		type:
			transaction.type === 'income' || transaction.type === 'expense' ? transaction.type : undefined
	});
}

/**
 * The SQL twin of resolveTransactionType, and the riskiest few lines in this feature.
 *
 * `Transaction.type` is nullable, and getTransactionKind falls back to the sign of `amountCents`
 * whenever it is not exactly 'income' or 'expense'. Reproducing that in SQL has one trap that no
 * amount of reading catches: `notIn` does NOT match NULL, because SQL three-valued logic makes
 * `NULL NOT IN (...)` unknown rather than true. Omitting the explicit `{ type: null }` branch
 * silently drops every row with no stored type from BOTH totals.
 *
 * That is exactly the class of defect CLAUDE.md records as invisible to unit tests: the fixture is
 * what replaces the SQL. totals.db-smoke.ts asserts this predicate and getTransactionKind agree
 * over the full type x sign matrix, against all three engines.
 */
export function transactionKindWhere(kind: TransactionKind): Prisma.TransactionWhereInput {
	const typeIsUnset: Prisma.TransactionWhereInput = {
		OR: [{ type: null }, { type: { notIn: ['income', 'expense'] } }]
	};

	if (kind === 'income') {
		return {
			OR: [{ type: 'income' }, { AND: [typeIsUnset, { amountCents: { gte: 0 } }] }]
		};
	}
	return {
		OR: [{ type: 'expense' }, { AND: [typeIsUnset, { amountCents: { lt: 0 } }] }]
	};
}

export interface FilteredTotals {
	incomeCents: number;
	expenseCents: number;
}

/**
 * The category dimension of the active filter, when there is one.
 *
 * Passed EXPLICITLY rather than sniffed out of the `where`: a predicate is a set, not a question,
 * and inspecting one to guess which question produced it is how a fix stops applying the day the
 * predicate's shape changes. `undefined` means "no category dimension", which is a different
 * calculation, not a degenerate case of this one.
 */
export interface CategoryTotalsScope {
	/** Scopes the part's own category, so a category id is never trusted across accounts. */
	userId: string;
	/** The raw `?category=` value. Matched by folded key, like every other category read. */
	name: string;
}

/**
 * Income and expense magnitudes over the WHOLE filtered set, not the current page.
 *
 * A sum, not a policy: no nature is excluded. Every existing "spend by X" site in this codebase
 * encodes its own rule about which natures count, and the five of them disagree. This one answers
 * a narrower question, "what does the set I am looking at add up to", so it needs no rule at all.
 *
 * WITH A CATEGORY DIMENSION IT SUMS THE MATCHING PARTS, NOT THE PARENTS, and that is not a
 * refinement — it is the difference between a true figure and a false one. Blast-radius row 35
 * classified this site **P** because the sum invariant makes parent and parts identical; true only
 * while the filter carries no category. Take OD-1 and it stops being true: filter by Maison, see the
 * 80 € Carrefour row, and a parent-based total announces 80,00 € of Maison spending when 20,00 €
 * went there.
 *
 * The two branches are separate queries rather than one clever predicate because they answer
 * different questions: a répartie row's money is entirely in its parts (the remainder is
 * structurally zero — see amount-immutability.spec.ts), and an unsplit row's money is entirely in
 * its parent. Summing both over the same rows would be the double-count §2.2 names.
 */
export async function computeFilteredTotals(
	where: Prisma.TransactionWhereInput,
	categoryScope?: CategoryTotalsScope
): Promise<FilteredTotals> {
	if (!categoryScope) {
		const [income, expense] = await Promise.all([
			prisma.transaction.aggregate({
				where: { AND: [where, transactionKindWhere('income')] },
				_sum: { amountCents: true }
			}),
			prisma.transaction.aggregate({
				where: { AND: [where, transactionKindWhere('expense')] },
				_sum: { amountCents: true }
			})
		]);

		return {
			incomeCents: Math.abs(income._sum.amountCents ?? 0),
			expenseCents: Math.abs(expense._sum.amountCents ?? 0)
		};
	}

	// Bound before the closure below, so the narrowing survives into it.
	const scope = categoryScope;
	const nameKey = computeNameKey(scope.name);

	async function sumForKind(kind: TransactionKind): Promise<number> {
		const matchedOfKind: Prisma.TransactionWhereInput = {
			AND: [where, transactionKindWhere(kind)]
		};

		const [unsplit, parts] = await Promise.all([
			// `where` already carries the category disjunction, and for a row with no parts its
			// `splits: { some: ... }` branch is false — so this reduces to exactly "the effective
			// category matches", with no second copy of that expression here.
			prisma.transaction.aggregate({
				where: { AND: [matchedOfKind, { splits: { none: {} } }] },
				_sum: { amountCents: true }
			}),
			// BOTH sides scoped, the rule tags/counts.ts states at length: the parent through
			// `where`'s own userId, and the part's category through its own userId conjunct. A foreign
			// key does not stop a part pointing at another account's category — only a scoped read does.
			//
			// The KIND comes from the parent (`matchedOfKind`), never from the part's sign: a part has
			// no type of its own, and `allocationsOf` gives every allocation its transaction's kind.
			prisma.transactionSplit.aggregate({
				where: {
					category: { is: { userId: scope.userId, nameKey } },
					transaction: matchedOfKind
				},
				_sum: { amountCents: true }
			})
		]);

		return Math.abs(unsplit._sum.amountCents ?? 0) + Math.abs(parts._sum.amountCents ?? 0);
	}

	const [incomeCents, expenseCents] = await Promise.all([
		sumForKind('income'),
		sumForKind('expense')
	]);
	return { incomeCents, expenseCents };
}

/** The columns sumFilteredTotals needs. Nothing here is optional, deliberately: a caller that
 *  selected the amount and forgot the parts would silently report a répartie row's whole total
 *  under whichever category the filter named. */
export interface TransactionRowForTotals {
	amountCents: number;
	type: string | null;
	manualCategory: string | null;
	category: { name: string } | null;
	splits: Array<{ amountCents: number; category: { name: string } }>;
}

/**
 * In-memory counterpart, for the `?q=` path where matching happens in JS and the rows are already
 * loaded. The two must agree; totals.spec.ts pins them against the same fixture, and
 * totals.db-smoke.ts runs the pair against every engine.
 *
 * The allocation half descends from `allocateByCategory` rather than restating the remainder rule,
 * so this side of the pair cannot drift from the definition the rest of the app reads money through.
 * The SQL side above is genuinely independent — columns and relation filters, not a JS expression —
 * which is what makes the agreement test worth running.
 */
export function sumFilteredTotals(
	rows: ReadonlyArray<TransactionRowForTotals>,
	categoryName?: string
): FilteredTotals {
	const nameKey = categoryName ? computeNameKey(categoryName) : null;
	let incomeCents = 0;
	let expenseCents = 0;

	for (const row of rows) {
		// The parent's kind governs every one of its allocations.
		const kind = resolveTransactionType(row);
		const contribution =
			nameKey === null
				? Math.abs(row.amountCents)
				: allocateByCategory(
						{ category: getEffectiveCategory(row), amountCents: row.amountCents },
						row.splits.map((split) => ({
							category: split.category.name,
							amountCents: split.amountCents
						}))
					)
						.filter((entry) => computeNameKey(entry.category) === nameKey)
						.reduce((total, entry) => total + Math.abs(entry.amountCents), 0);

		if (kind === 'income') incomeCents += contribution;
		else expenseCents += contribution;
	}

	return { incomeCents, expenseCents };
}
