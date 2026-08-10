import { normalizeForMatch } from './normalize';
import {
	getTransactionKind,
	type Transaction,
	type TransactionKind,
	type TransactionNature
} from './transaction';

/**
 * Floor on the number of parts in a répartition.
 *
 * A one-part split is a category wearing a costume: added complexity, no benefit. Removing the
 * répartition entirely is a separate, explicit action, never the side effect of deleting parts
 * until one is left.
 */
export const MIN_SPLITS_PER_TRANSACTION = 2;

/**
 * Ceiling on the number of parts, enforced server-side independently of any UI.
 *
 * Well past any real receipt, low enough to bound a forged request. It lives in domain/ rather
 * than in the write path because the backup validator needs it too — the payload bound is
 * `transactions.length * MAX_SPLITS_PER_TRANSACTION`, which is a claim about every write path
 * rather than about one function. Same placement, and the same reasoning, as
 * MAX_TAGS_PER_TRANSACTION in domain/tags.ts.
 */
export const MAX_SPLITS_PER_TRANSACTION = 20;

/**
 * Write-path cap on a part's free-text note.
 *
 * Deliberately tighter than the backup schema's MAX_PORTABLE_STRING (191): this bounds what THIS
 * version produces, while the backup bound must still accept what an older version legally wrote.
 * The same split the Account.providerAccountId note records.
 */
export const MAX_SPLIT_NOTE_LENGTH = 80;

/**
 * Normalizes a part's note, exactly as normalizeTagName does for a tag and for the same reason.
 *
 * A note is user-authored free text that is RENDERED — in the editor, in the list row's tooltip,
 * and beside a part in a confirmation. So it inherits the hazard tags already reasoned through: a
 * bidi override (U+202E) or a zero-width character makes a stored string display as something
 * other than what is stored. Svelte escapes, so this is not an injection sink; it is a spoofing
 * one, and the mitigation is to strip the class rather than to escape it.
 *
 * Deliberately does NOT reject `<` and `>`, matching the tag decision rather than the category
 * one: a note is something a user writes for themselves and may legitimately contain "8<->12".
 *
 * Returns '' for a note that was only whitespace or only stripped characters, which every caller
 * stores as NULL — so "has a note" stays one question rather than two.
 */
export function normalizeSplitNote(raw: string | null | undefined): string {
	return (raw ?? '')
		.replace(/[\p{Cc}\p{Cf}]/gu, '')
		.trim()
		.replace(/\s+/g, ' ');
}

/**
 * THE PER-PART AMOUNT RULE, expressed once, for every path that writes a `TransactionSplit`.
 *
 * A part must be a safe integer, non-zero, and carry the PARENT's sign. Zero says nothing, and an
 * opposite sign is a refund or a transfer rather than an allocation — allowing one would let a
 * répartition SUM CORRECTLY while containing a part that no per-category total can interpret.
 * Measured, on a real instance: parent −80,00 €, parts forged to −130,00 € and +50,00 €. Sum
 * exact, count 2, both categories present. Every per-category and per-nature reader takes
 * `Math.abs(allocation.amountCents)`, so Σ|allocations| was 180,00 € for an 80,00 € transaction
 * and `/reports` expenseCents went 21450 → 31450. Once stored, those rows are indistinguishable
 * from good ones: nothing records which write path produced a part.
 *
 * It lives here rather than in the write path for the reason MAX_SPLITS_PER_TRANSACTION does: it
 * is a claim about EVERY write path, not about one function. The rule was enforced in
 * `replaceSplits` alone, and the restore does not go through `replaceSplits`.
 *
 * THE WRITE-PATH MATRIX for `TransactionSplit`, so the next writer knows what it inherits and what
 * it must supply. `+` enforced, `—` not applicable, `✗` not enforced.
 *
 * | Path | sum | count | amount (this fn) | tx ownership | category ownership | position |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | `replaceSplits` (form action + CSV import via `import/persist.ts`) | + | + | + | + | + | + |
 * | `clearSplits` (deletes only) | — | — | — | + | — | — |
 * | restore, `backup/import.ts` (`assertReferentialIntegrity` then `createMany`) | + | + | + | + | + | + |
 * | category-rename backfill, `naming/backfill.ts` (`updateMany`, `categoryId` only) | — | — | — | + | + | — |
 *
 * Notes on the two that are not obvious. The restore's ownership is structural rather than a
 * conjunct: every id in the payload is REGENERATED and every parent row is created under the
 * restoring `userId` in the same transaction, so a part cannot reach a row it does not own; its
 * positions come from the zod schema (`int().min(0)`). The backfill re-points parts at the
 * surviving category of a fold, under a `where` already scoped to the user's own categories, and
 * touches no amount — so it cannot break an invariant it does not need to check.
 *
 * A REAL PARENT AMOUNT IS REQUIRED, AND THE CALLER OWES IT. The type says so, and the type is all
 * that says so: this compares SIGNS, so an `undefined` arriving through a non-null assertion or an
 * `any` makes every NEGATIVE part answer true — `(-2000 > 0) === (undefined >= 0)` is
 * `false === false` — a fail-OPEN answer in the direction most of this app's parts point. Each call
 * site therefore establishes the parent first and refuses when it cannot: `backup/import.ts`
 * refuses a part whose parent is absent from the payload, `replaceSplits` re-reads the parent row
 * inside its own transaction. The check is not repeated in here, where the parameter's type would
 * have to be widened to `number | undefined` to express a state no caller is allowed to be in.
 */
export function isValidSplitPartAmount(amountCents: number, parentAmountCents: number): boolean {
	return (
		Number.isSafeInteger(amountCents) &&
		amountCents !== 0 &&
		amountCents > 0 === parentAmountCents >= 0
	);
}

/**
 * One (category, amount) pair resolved from a transaction. NOT a Transaction, and the distinction
 * is the entire protection: an allocation has no identity, cannot be counted as an occurrence,
 * cannot anchor a recurring stream, and must never be a grouping key for anything but its own
 * category. `transactionId` is for drill-down and de-duplication only.
 */
export interface CategoryAllocation {
	transactionId: string;
	date: string;
	category: string;
	amountCents: number;
	nature: TransactionNature;
	kind: TransactionKind;
}

/** The smallest thing the remainder rule needs to know about a whole or a part. */
export interface CategoryAmount {
	category: string;
	amountCents: number;
}

/**
 * THE REMAINDER RULE, expressed once, over nothing but (category, amount) pairs.
 *
 *   allocate(whole, parts) = parts ++ [ { whole.category, whole.amountCents − Σ parts } ]
 *   with the trailing element dropped when its amount is 0 and there is something left to return.
 *
 * `allocationsOf` below is this function plus identity and nature. It is factored out because
 * `readCurrentMonthSpending` asks only "where did the money go" — it selects neither the columns a
 * Transaction needs nor the nature mappings — and the alternative was for it to spell the rule out
 * a second time. A per-category read that re-derives the remainder is exactly the duplicated
 * decision this whole design exists to remove, so the rule lives here and both callers descend
 * from it.
 *
 * The returned `part` is the input element the entry came from, or `null` for the remainder. That
 * is what lets `allocationsOf` carry each part's own nature through without this function knowing
 * what a nature is.
 */
export function allocateByCategory<P extends CategoryAmount>(
	whole: CategoryAmount,
	parts: ReadonlyArray<P>
): Array<{ category: string; amountCents: number; part: P | null }> {
	const allocated = parts.map((part) => ({
		category: part.category,
		amountCents: part.amountCents,
		part
	}));

	const partsSum = allocated.reduce((sum, entry) => sum + entry.amountCents, 0);
	const remainderCents = whole.amountCents - partsSum;
	if (remainderCents === 0 && allocated.length > 0) return allocated;

	return [...allocated, { category: whole.category, amountCents: remainderCents, part: null }];
}

/**
 * allocations(t) = t.parts ++ [ { category: t.category, amountCents: t.amountCents − Σ parts } ]
 *                  with the trailing element dropped when its amount is 0.
 *
 * Total by construction, which is why there is no special case anywhere downstream:
 *  - unsplit         → one allocation, the whole amount, under the parent's category;
 *  - correctly split → remainder 0 → exactly the parts;
 *  - amount moved out from under the parts → the parts PLUS the difference.
 * Therefore Σ allocations ≡ Σ transaction totals. Conservation is a theorem, not a hope, which is
 * what makes it safe to keep the anti-double-count guard switched on — a guard that fires on good
 * data gets switched off.
 *
 * A part's `nature` falls back to the transaction's nature when not supplied. The remainder
 * element always carries the transaction's own category and nature.
 *
 * TWO EDGE CASES THE ONE-LINE DEFINITION ABOVE DOES NOT COVER, both deliberate:
 *
 *  - An UNSPLIT transaction always yields exactly one allocation, even when its amount is 0.
 *    Read literally, "drop the trailing element when its amount is 0" would return [] for a
 *    zero-amount transaction and the anti-double-count guard's second assertion — every
 *    transaction covered exactly once — would fail on legitimate data. The drop applies only
 *    when there is something left to return.
 *
 *  - `nature` is REQUIRED on the input, not optional as it is on the domain Transaction. Both
 *    read boundaries already resolve it through getEffectiveTransactionNature before building a
 *    Transaction, so this costs nothing today and makes "a boundary forgot to resolve nature" a
 *    compile error. Defaulting instead would have to pick a value, and every available value is
 *    a lie: 'uncategorized' is a real nature the user can hold, so it would silently conflate
 *    "we do not know" with "the user classified it that way" — in a function whose whole job is
 *    to bucket money.
 */
export function allocationsOf(
	transaction: Transaction & { nature: TransactionNature },
	parts?: ReadonlyArray<{ category: string; amountCents: number; nature?: TransactionNature }>
): CategoryAllocation[] {
	const kind = getTransactionKind(transaction);
	const transactionNature = transaction.nature;

	return allocateByCategory(
		{ category: transaction.category, amountCents: transaction.amountCents },
		parts ?? []
	).map((entry) => ({
		transactionId: transaction.id,
		date: transaction.date,
		category: entry.category,
		amountCents: entry.amountCents,
		// `entry.part` is null exactly for the remainder, which always carries the transaction's own
		// nature. A part with no nature of its own falls back to the same value.
		nature: entry.part?.nature ?? transactionNature,
		kind
	}));
}

/**
 * Largest-remainder split of `totalCents` into `n` parts, extra cent(s) going to the FIRST parts.
 *
 * For total `T`, sign `s = sign(T)`, `A = |T|`, `q = ⌊A/n⌋`, `r = A − qn` with `0 ≤ r < n`: the
 * first `r` parts get `s(q+1)`, the remaining `n − r` get `sq`.
 * `Σ = s(r(q+1) + (n−r)q) = s(rq + r + nq − rq) = s(nq + r) = sA = T`. Exact by construction, for
 * every `n ≥ 1` and either sign. ∎
 *
 * WHY "first parts" is load-bearing rather than an arbitrary tiebreak: `TransactionSplit.position`
 * exists precisely so that WHICH part carries the rounding cent is stable and visible to the user
 * — not an implementation detail free to move between reads. The editor's UI names it explicitly
 * ("la première part reçoit le centime restant" or equivalent), so silently moving the remainder
 * to the last parts, or splitting it evenly across all of them, would make that sentence a lie
 * without ever touching the sentence itself.
 *
 * Deliberately produces zero-valued parts when `|totalCents| < n` — see the note on
 * `replaceSplits` (domain/allocation.ts's own docstring above) for why that is the editor's
 * problem to avoid, not this function's.
 */
export function distributeEvenly(totalCents: number, n: number): number[] {
	const sign = totalCents < 0 ? -1 : 1;
	const absolute = Math.abs(totalCents);
	const quotient = Math.floor(absolute / n);
	const remainder = absolute - quotient * n;

	return Array.from(
		{ length: n },
		(_, index) => sign * (index < remainder ? quotient + 1 : quotient)
	);
}

/**
 * What the list row's indicator shows (design 1l): the dominant category, and a count.
 *
 * Derived from ALLOCATIONS rather than from the raw parts, deliberately. The rule the column has
 * to obey is "where did the money go", and `allocationsOf` is the one place that answers it — a
 * répartition whose parts no longer sum (a hand-edited backup is the only way in, and the
 * validator refuses it, but nothing about this function needs that to be true) carries a phantom
 * remainder under the parent's category, and the badge counts it because the money is really
 * there. Restating the rule over `splits` instead would be the oracle mistake: a second copy of a
 * decision, agreeing today and free to drift.
 */
export interface SplitIndicator {
	/** The heaviest allocation's category — what the cell prints in place of the parent's. */
	dominantCategory: string;
	/** That same allocation's nature. One rule for both lines of the desktop cell. */
	dominantNature: TransactionNature;
	/** N in « +N »: DISTINCT other categories, not other parts. Zero is a legitimate answer. */
	otherCategoryCount: number;
	/** N in « ×N »: how many allocations there are, used only when otherCategoryCount is 0. */
	partCount: number;
	/** Every allocation, in position order, for the tooltip and the accessible name. */
	parts: Array<{ category: string; amountCents: number }>;
}

/**
 * `null` for an unsplit transaction — which `allocationsOf` renders as exactly one allocation, so
 * the test is a length rather than a flag and no caller needs to know what a `TransactionSplit` is.
 *
 * DOMINANT IS THE LARGEST BY MAGNITUDE, and that is the whole reason this is not a `sort`. Amounts
 * carry the parent's sign, so on an expense every part is negative and "the largest" by the natural
 * comparison is the SMALLEST part — the one answer that is never right. Ties go to the earliest
 * allocation, which is position order (`EFFECTIVE_CATEGORY_SELECT` orders the parts, and the
 * remainder is appended last), so the display is stable and reproducible rather than dependent on
 * a sort's stability.
 *
 * Categories are counted through `normalizeForMatch`, the same fold every other category
 * comparison in the app uses. It matters for exactly one shape: the phantom remainder above
 * carries the parent's EFFECTIVE category, which may be a free-text `manualCategory` differing
 * from a part's `Category.name` only in case or accent. Counting those as two would report an
 * extra category that does not exist.
 */
export function splitIndicatorOf(
	allocations: ReadonlyArray<CategoryAllocation>
): SplitIndicator | null {
	if (allocations.length < 2) return null;

	let dominant = allocations[0];
	for (const allocation of allocations) {
		if (Math.abs(allocation.amountCents) > Math.abs(dominant.amountCents)) dominant = allocation;
	}

	const distinctCategories = new Set(
		allocations.map((allocation) => normalizeForMatch(allocation.category))
	);

	return {
		dominantCategory: dominant.category,
		dominantNature: dominant.nature,
		otherCategoryCount: distinctCategories.size - 1,
		partCount: allocations.length,
		parts: allocations.map((allocation) => ({
			category: allocation.category,
			amountCents: allocation.amountCents
		}))
	};
}

/**
 * `splitIndicatorOf`, grouped by `transactionId` and indexed for lookup — for a surface that has to
 * answer "is THIS transaction split" for many transactions (the dashboard's recent list, the
 * reports' largest expenses, an upcoming-bills occurrence) without re-deriving the grouping at
 * every call site. That grouping is the one thing worth sharing here: nothing about "where did the
 * money go" changes between callers, only which transaction they are asking about.
 *
 * Absent from the returned map for an unsplit transaction (or one with no allocation in the input
 * at all) — the same "null means unsplit" contract `splitIndicatorOf` already has, just keyed
 * instead of positional. `.get(id) ?? null` at every call site reads the same way.
 */
export function splitIndicatorsByTransactionId(
	allocations: ReadonlyArray<CategoryAllocation>
): Map<string, SplitIndicator> {
	const grouped = new Map<string, CategoryAllocation[]>();
	for (const allocation of allocations) {
		const existing = grouped.get(allocation.transactionId);
		if (existing) existing.push(allocation);
		else grouped.set(allocation.transactionId, [allocation]);
	}

	const indicators = new Map<string, SplitIndicator>();
	for (const [transactionId, group] of grouped) {
		const indicator = splitIndicatorOf(group);
		if (indicator) indicators.set(transactionId, indicator);
	}
	return indicators;
}
