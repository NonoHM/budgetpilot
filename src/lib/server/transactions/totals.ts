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
 * Σ|amountCents| over a predicate — the SQL half of `sumFilteredTotals`'s per-row `Math.abs`.
 *
 * TWO AGGREGATES, NOT ONE, AND THE DIFFERENCE IS A FALSE FIGURE ON SCREEN. This used to be a single
 * `_sum` with `Math.abs` applied to its RESULT, which is `|Σx|` and not `Σ|x|`. Those are the same
 * number only while every row in the bucket shares a stored sign, and they do not: `persist.ts`
 * stores `Math.abs(amountCents)` for every CSV import while a manually added transaction stores a
 * signed one, so any user who has done both holds an expense bucket containing rows of both signs,
 * and inside that bucket a positive-stored expense CANCELLED a negative-stored one.
 *
 * Measured on a seeded instance at `/transactions?type=expense`: the band read 99,47 € against a
 * true 399,47 €, short by exactly twice the 150,00 € of positive-stored magnitudes. The `?q=` path
 * beside it, which goes through `sumFilteredTotals`, was already exact — so two figures for one set
 * disagreed depending on whether the user had typed anything in the search box.
 *
 * Splitting the predicate by sign and SUBTRACTING the negative half is exact and needs no `ABS()`:
 * Σ|x| = Σ(x ≥ 0) − Σ(x < 0), and `Math.abs` never appears, so nothing here can be misread as the
 * `|Σx|` this replaces. Raw SQL with `SUM(ABS(...))` would be one query instead of two, and is
 * refused: it cannot compose with `buildTransactionWhere`'s predicate, which is the object every
 * other reader of this filter shares.
 *
 * The two halves run concurrently, so the added cost is a query rather than a round trip.
 */
async function sumTransactionMagnitudes(where: Prisma.TransactionWhereInput): Promise<number> {
	const [positive, negative] = await Promise.all([
		prisma.transaction.aggregate({
			where: { AND: [where, { amountCents: { gte: 0 } }] },
			_sum: { amountCents: true }
		}),
		prisma.transaction.aggregate({
			where: { AND: [where, { amountCents: { lt: 0 } }] },
			_sum: { amountCents: true }
		})
	]);

	return (positive._sum.amountCents ?? 0) - (negative._sum.amountCents ?? 0);
}

/** `sumTransactionMagnitudes` over the parts table. Parts carry the PARENT ROW's stored sign
 *  (`replaceSplits` enforces it), so an imported répartition is stored entirely positive and the
 *  part aggregate cancels exactly the way the parent one did. */
async function sumSplitMagnitudes(where: Prisma.TransactionSplitWhereInput): Promise<number> {
	const [positive, negative] = await Promise.all([
		prisma.transactionSplit.aggregate({
			where: { AND: [where, { amountCents: { gte: 0 } }] },
			_sum: { amountCents: true }
		}),
		prisma.transactionSplit.aggregate({
			where: { AND: [where, { amountCents: { lt: 0 } }] },
			_sum: { amountCents: true }
		})
	]);

	return (positive._sum.amountCents ?? 0) - (negative._sum.amountCents ?? 0);
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
		const [incomeCents, expenseCents] = await Promise.all([
			sumTransactionMagnitudes({ AND: [where, transactionKindWhere('income')] }),
			sumTransactionMagnitudes({ AND: [where, transactionKindWhere('expense')] })
		]);

		return { incomeCents, expenseCents };
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
			sumTransactionMagnitudes({ AND: [matchedOfKind, { splits: { none: {} } }] }),
			// BOTH sides scoped, the rule tags/counts.ts states at length: the parent through
			// `where`'s own userId, and the part's category through its own userId conjunct. A foreign
			// key does not stop a part pointing at another account's category — only a scoped read does.
			//
			// The KIND comes from the parent (`matchedOfKind`), never from the part's sign: a part has
			// no type of its own, and `allocationsOf` gives every allocation its transaction's kind.
			sumSplitMagnitudes({
				category: { is: { userId: scope.userId, nameKey } },
				transaction: matchedOfKind
			})
		]);

		return unsplit + parts;
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
 * The result of narrowing an already-flattened allocation list to the ones matching a folded
 * category key — `allocateByCategory`'s own output for a row's amount (this file), or
 * `mapTransactionAllocations`'s richer, nature-bearing output for a list row's DISPLAY (see
 * `+page.server.ts`). One shape, two callers, so a transaction list row and the filtered-totals
 * band read the matched amount from the SAME computation: PR5's "Σ rows ≡ band" is a theorem, not
 * a hope kept true by two copies that happen to agree today. See CLAUDE.md's recorded incident
 * where a spec retyped `manualCategory ?? category.name` and drifted by the sentinel fallback.
 */
export interface MatchedAllocation<T> {
	/** The heaviest matching entry — DOMINANT by magnitude, ties to the earliest — for display:
	 *  which category/nature a row under a category filter shows. Same tie rule as
	 *  `splitIndicatorOf`, applied to the narrower set that matched instead of to the whole row. */
	entry: T;
	/** Unsigned sum of every matching entry's magnitude (two parts filed under the same category
	 *  both count). What `sumFilteredTotals` adds into its income/expense bucket; a row applies its
	 *  own kind's sign to it before display, since a signed sum of the raw entries would let a
	 *  hand-forged pair of opposite-sign parts in one category silently cancel instead of add. */
	amountCentsAbs: number;
}

/**
 * `null` when nothing in `allocations` matches `nameKey` — a row a category filter should never
 * have matched in the first place (see the `?category=` identity-match case documented on
 * `computeFilteredTotals` above, where the parent's own category matches but no part's money did).
 */
export function pickMatchedAllocation<T extends { category: string; amountCents: number }>(
	allocations: ReadonlyArray<T>,
	nameKey: string
): MatchedAllocation<T> | null {
	const matches = allocations.filter((entry) => computeNameKey(entry.category) === nameKey);
	if (matches.length === 0) return null;

	let dominant = matches[0];
	let amountCentsAbs = 0;
	for (const entry of matches) {
		amountCentsAbs += Math.abs(entry.amountCents);
		if (Math.abs(entry.amountCents) > Math.abs(dominant.amountCents)) dominant = entry;
	}
	return { entry: dominant, amountCentsAbs };
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
				: (pickMatchedAllocation(
						allocateByCategory(
							{ category: getEffectiveCategory(row), amountCents: row.amountCents },
							row.splits.map((split) => ({
								category: split.category.name,
								amountCents: split.amountCents
							}))
						),
						nameKey
					)?.amountCentsAbs ?? 0);

		if (kind === 'income') incomeCents += contribution;
		else expenseCents += contribution;
	}

	return { incomeCents, expenseCents };
}
