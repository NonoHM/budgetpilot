import { describe, it, expect } from 'vitest';
import {
	allocationsOf,
	distributeEvenly,
	isValidSplitPartAmount,
	splitIndicatorOf,
	splitIndicatorsByTransactionId
} from './allocation';
import type { Transaction } from './transaction';
import type { CategoryAllocation } from './allocation';

// `satisfies` rather than a type annotation: allocationsOf requires a resolved `nature`, which the
// domain Transaction leaves optional, so annotating as Transaction would widen it back to
// `TransactionNature | undefined` and stop compiling. This still checks Transaction conformance.
const tx = {
	id: 't1',
	date: '2026-06-24',
	label: 'Carrefour Market',
	amountCents: -8000,
	category: 'Alimentation',
	source: 'csv',
	nature: 'spending'
} satisfies Transaction;

describe('allocationsOf', () => {
	it('gives an unsplit transaction exactly one allocation carrying its whole amount', () => {
		expect.assertions(2);
		const allocations = allocationsOf(tx);
		expect(allocations).toHaveLength(1);
		expect(allocations[0]).toMatchObject({
			transactionId: 't1',
			category: 'Alimentation',
			amountCents: -8000
		});
	});

	it('drops the remainder when the parts sum exactly, so a split yields only its parts', () => {
		expect.assertions(2);
		const allocations = allocationsOf(tx, [
			{ category: 'Alimentation', amountCents: -6000 },
			{ category: 'Maison', amountCents: -2000 }
		]);
		expect(allocations).toHaveLength(2);
		expect(allocations.reduce((s, a) => s + a.amountCents, 0)).toBe(-8000);
	});

	it('emits the difference as a trailing remainder under the parent category when parts do not sum', () => {
		expect.assertions(2);
		const allocations = allocationsOf(tx, [{ category: 'Maison', amountCents: -2000 }]);
		expect(allocations).toHaveLength(2);
		expect(allocations.at(-1)).toMatchObject({ category: 'Alimentation', amountCents: -6000 });
	});

	it('carries each part its own nature when parts declare different natures', () => {
		expect.assertions(3);
		const allocations = allocationsOf(tx, [
			{ category: 'Alimentation', amountCents: -6000, nature: 'spending' },
			{ category: 'Épargne', amountCents: -2000, nature: 'investment' }
		]);
		expect(allocations).toHaveLength(2);
		expect(allocations[0].nature).toBe('spending');
		expect(allocations[1].nature).toBe('investment');
	});

	// The edge the literal definition gets wrong: "drop the trailing element when its amount is 0"
	// would return [] here, and allocation.db-smoke.ts asserts every transaction is covered exactly
	// once — so a zero-amount transaction would fail that guard on entirely legitimate data.
	it('still yields one allocation for an unsplit transaction whose amount is zero', () => {
		expect.assertions(2);
		const allocations = allocationsOf({ ...tx, amountCents: 0 });
		expect(allocations).toHaveLength(1);
		expect(allocations[0]).toMatchObject({ category: 'Alimentation', amountCents: 0 });
	});

	it('treats an empty parts array identically to undefined, as one whole-amount allocation', () => {
		expect.assertions(2);
		const allocations = allocationsOf(tx, []);
		expect(allocations).toHaveLength(1);
		expect(allocations[0]).toMatchObject({
			transactionId: 't1',
			category: 'Alimentation',
			amountCents: -8000
		});
	});
});

describe('distributeEvenly', () => {
	it('gives the extra cents to the FIRST parts, and sums exactly, for every (total, n)', () => {
		// 4 literal assertions, then the exhaustive sweep: n from 2 to 20 (19 values) times 6 totals.
		expect.assertions(4 + 6 * 19);

		expect(distributeEvenly(10000, 3)).toEqual([3334, 3333, 3333]);
		expect(distributeEvenly(-10000, 3)).toEqual([-3334, -3333, -3333]);
		expect(distributeEvenly(8000, 2)).toEqual([4000, 4000]);
		expect(distributeEvenly(5, 20)).toEqual([1, 1, 1, 1, 1, ...Array(15).fill(0)]);

		// The assertion that matters: for every n and every total, the parts sum EXACTLY to the
		// total. The four literals above exist only so a reader can see the shape by eye.
		for (let n = 2; n <= 20; n++) {
			for (const total of [10000, -10000, 1, -1, 99, 100000001]) {
				const parts = distributeEvenly(total, n);
				expect(parts.reduce((sum, part) => sum + part, 0)).toBe(total);
			}
		}
	});

	// This is not an edge case to dismiss: it is a real interaction with replaceSplits (a later
	// task), which REFUSES a part of 0. distributeEvenly's only guarantee is the SUM — when
	// |total| < n, zero-valued parts are the only way to keep it exact, so it must produce them.
	// The editor's job is to not offer an even split that would produce a zero part; it is NOT
	// distributeEvenly's job to avoid zeros, and "fixing" it to dodge zeros would silently break
	// the sum guarantee for small totals. See domain/allocation.ts's docstring and Task 6.4.
	it('produces zero-valued parts when the total is smaller than the part count, by design', () => {
		expect.assertions(2);
		const parts = distributeEvenly(5, 20);
		expect(parts.filter((p) => p === 0)).toHaveLength(15);
		expect(parts.reduce((sum, part) => sum + part, 0)).toBe(5);
	});
});

describe('splitIndicatorOf', () => {
	// Built through allocationsOf rather than hand-written, so the fixture is whatever the real
	// producer emits — including where the remainder lands and in what order.
	const income = {
		id: 't2',
		date: '2026-06-24',
		label: 'Virement employeur',
		amountCents: 8000,
		category: 'Salaire',
		source: 'csv',
		nature: 'income'
	} satisfies Transaction;

	it('returns null for an unsplit transaction, on either sign', () => {
		expect.assertions(2);
		expect(splitIndicatorOf(allocationsOf(tx))).toBeNull();
		expect(splitIndicatorOf(allocationsOf(income))).toBeNull();
	});

	// The load-bearing sign test. On an expense every allocation is negative, so the largest by the
	// NATURAL comparison is the smallest part — the one answer that is never right. Both signs are
	// fixtured deliberately: the income case below passes with or without the magnitude rule, and
	// knowing which half of the domain a test can actually see is the point of writing both.
	it('picks the heaviest part by MAGNITUDE on an expense, not the largest signed amount', () => {
		expect.assertions(1);
		const indicator = splitIndicatorOf(
			allocationsOf(tx, [
				{ category: 'Alimentation', amountCents: -2000 },
				{ category: 'Maison', amountCents: -6000 }
			])
		);
		expect(indicator?.dominantCategory).toBe('Maison');
	});

	it('picks the heaviest part on an income too, where the magnitude rule is invisible', () => {
		expect.assertions(1);
		const indicator = splitIndicatorOf(
			allocationsOf(income, [
				{ category: 'Salaire', amountCents: 2000 },
				{ category: 'Primes', amountCents: 6000 }
			])
		);
		expect(indicator?.dominantCategory).toBe('Primes');
	});

	it('breaks a tie on position, so equal parts always display the same way', () => {
		expect.assertions(2);
		const indicator = splitIndicatorOf(
			allocationsOf(tx, [
				{ category: 'Maison', amountCents: -4000 },
				{ category: 'Alimentation', amountCents: -4000 }
			])
		);
		expect(indicator?.dominantCategory).toBe('Maison');
		// Position order is the order allocationsOf received the parts in, which is the order
		// EFFECTIVE_CATEGORY_SELECT reads them in. Reversing the input reverses the answer — which
		// is what makes this a rule rather than an accident of Array.prototype.sort's stability.
		const reversed = splitIndicatorOf(
			allocationsOf(tx, [
				{ category: 'Alimentation', amountCents: -4000 },
				{ category: 'Maison', amountCents: -4000 }
			])
		);
		expect(reversed?.dominantCategory).toBe('Alimentation');
	});

	it('counts DISTINCT other categories, not other parts', () => {
		expect.assertions(2);
		const indicator = splitIndicatorOf(
			allocationsOf(tx, [
				{ category: 'Alimentation', amountCents: -5000 },
				{ category: 'Alimentation', amountCents: -1000 },
				{ category: 'Maison', amountCents: -2000 }
			])
		);
		// Three parts, two categories: « Alimentation +1 ». Counting parts would say « +2 », which
		// is false in a column called Catégorie.
		expect(indicator?.otherCategoryCount).toBe(1);
		expect(indicator?.partCount).toBe(3);
	});

	it('reports zero other categories when every part shares one, so the caller can say « ×N »', () => {
		expect.assertions(3);
		const indicator = splitIndicatorOf(
			allocationsOf(tx, [
				{ category: 'Alimentation', amountCents: -4000 },
				{ category: 'Alimentation', amountCents: -4000 }
			])
		);
		expect(indicator).not.toBeNull();
		expect(indicator?.otherCategoryCount).toBe(0);
		expect(indicator?.partCount).toBe(2);
	});

	it('folds the phantom remainder onto a part sharing its category up to case and accent', () => {
		expect.assertions(2);
		// The parent's effective category can be a free-text manualCategory; a part's is a
		// Category.name. Counting « alimentation » and « Alimentation » as two would report a
		// category the user does not have.
		const lowercased = { ...tx, category: 'alimentation' } satisfies Transaction;
		const indicator = splitIndicatorOf(
			allocationsOf(lowercased, [
				{ category: 'Alimentation', amountCents: -3000 },
				{ category: 'Alimentation', amountCents: -3000 }
			])
		);
		expect(indicator?.partCount).toBe(3);
		expect(indicator?.otherCategoryCount).toBe(0);
	});

	it('carries every allocation through in order, remainder last, for the tooltip', () => {
		expect.assertions(1);
		const indicator = splitIndicatorOf(
			allocationsOf(tx, [
				{ category: 'Maison', amountCents: -3000 },
				{ category: 'Transport', amountCents: -1000 }
			])
		);
		expect(indicator?.parts).toEqual([
			{ category: 'Maison', amountCents: -3000 },
			{ category: 'Transport', amountCents: -1000 },
			// The parts do not sum to −80,00 €, so the remainder is real and must be listed: the
			// tooltip claims to account for the money.
			{ category: 'Alimentation', amountCents: -4000 }
		]);
	});

	it('takes the nature from the dominant allocation, not from the parent (OD-4)', () => {
		expect.assertions(1);
		const indicator = splitIndicatorOf(
			allocationsOf(tx, [
				{ category: 'Épargne', amountCents: -6000, nature: 'transfer' },
				{ category: 'Alimentation', amountCents: -2000 }
			])
		);
		expect(indicator?.dominantNature).toBe('transfer');
	});
});

/**
 * BOTH SIGNS GET A FIXTURE. An expense and an income are not "the same rule with a minus": the
 * predicate's whole job is to compare a part's sign with its parent's, so a suite written around
 * whichever sign came to mind first would pass on half the world. Expenses are most of this app's
 * transactions, which is exactly why the income half is the one that would have been forgotten.
 */
describe('isValidSplitPartAmount', () => {
	it('accepts a part carrying the parent sign, on an expense and on an income alike', () => {
		expect.assertions(2);
		expect(isValidSplitPartAmount(-2000, -8000)).toBe(true);
		expect(isValidSplitPartAmount(2000, 8000)).toBe(true);
	});

	it('refuses a part whose sign is opposite the parent, in both directions', () => {
		expect.assertions(2);
		expect(isValidSplitPartAmount(5000, -8000)).toBe(false);
		expect(isValidSplitPartAmount(-5000, 8000)).toBe(false);
	});

	it('refuses zero, which says nothing about where money went', () => {
		expect.assertions(2);
		expect(isValidSplitPartAmount(0, -8000)).toBe(false);
		expect(isValidSplitPartAmount(0, 8000)).toBe(false);
	});

	it('refuses a non-integer and a non-safe integer', () => {
		expect.assertions(3);
		expect(isValidSplitPartAmount(-2000.5, -8000)).toBe(false);
		expect(isValidSplitPartAmount(-(Number.MAX_SAFE_INTEGER + 2), -8000)).toBe(false);
		expect(isValidSplitPartAmount(Number.NaN, -8000)).toBe(false);
	});

	/**
	 * THE HAZARD, pinned where it is, so no caller inherits it by accident.
	 *
	 * This is not a desirable behaviour being locked in; it is the REASON every call site refuses a
	 * missing parent before calling. The function compares signs, so an absent parent makes every
	 * NEGATIVE part answer true — and negative parts are most of this app's parts, which makes the
	 * failure open, silent, and in the common direction. `backup/import.ts` refuses a part whose
	 * parent is not in the payload (twice over: the dangling-transaction loop, and an explicit
	 * `=== undefined` beside this call); `replaceSplits` re-reads the parent row inside its own
	 * transaction and cannot proceed without it.
	 *
	 * If a future change makes this return false for an absent parent, that is an improvement:
	 * delete this test rather than weakening it, and say at both call sites that the guard there is
	 * now belt and braces. What must never happen is this assertion being read as "undefined is
	 * handled".
	 */
	it('cannot answer for a missing parent, which is why the callers refuse one first', () => {
		expect.assertions(2);
		const absentParent = undefined as unknown as number;
		expect(isValidSplitPartAmount(-2000, absentParent)).toBe(true);
		// The positive part is refused, which is what makes the hazard asymmetric and easy to miss:
		// a fixture built from an income would have reported this as safe.
		expect(isValidSplitPartAmount(2000, absentParent)).toBe(false);
	});

	// A zero-amount parent is treated as positive, matching `getTransactionKind` and every other
	// sign test in the app: `>= 0` rather than `> 0`. It cannot arise from a legal répartition
	// anyway, since two non-zero parts of one sign can never sum to zero — pinned so the tie-break
	// is a decision rather than an accident of operator choice.
	it('treats a zero parent as positive', () => {
		expect.assertions(2);
		expect(isValidSplitPartAmount(100, 0)).toBe(true);
		expect(isValidSplitPartAmount(-100, 0)).toBe(false);
	});
});

/**
 * The grouped form, tested directly rather than only through the three surfaces that call it.
 *
 * It is a wrapper over `splitIndicatorOf`, so the interesting properties are not about the
 * remainder rule — that is proven above — but about the GROUPING: that an interleaved list is
 * bucketed correctly, that "absent from the map" really is the same fact as `null`, and that a
 * transaction's own allocations are the only ones its indicator sees. Every fixture the three
 * callers build happens to arrive pre-grouped and contiguous, so none of them could show it.
 */
describe('splitIndicatorsByTransactionId', () => {
	// Typed as the real `CategoryAllocation` rather than as an inline object literal: `vitest` runs
	// specs through a transpile-only path, so a fixture missing a field is invisible to it and shows
	// up only in `npm run check`. That happened while writing this block — `date` and `kind` were
	// absent and all four tests were green.
	const alloc = (
		transactionId: string,
		category: string,
		amountCents: number
	): CategoryAllocation => ({
		transactionId,
		date: '2026-06-12',
		category,
		amountCents,
		nature: 'spending',
		kind: 'expense'
	});

	it('buckets an INTERLEAVED list by transaction, not by adjacency', () => {
		expect.assertions(3);

		// Deliberately shuffled: a grouping that assumed contiguity would put A's second part in B.
		const indicators = splitIndicatorsByTransactionId([
			alloc('a', 'Maison', -3000),
			alloc('b', 'Loisirs', -700),
			alloc('a', 'Transport', -1000),
			alloc('b', 'Transport', -800)
		]);

		expect(indicators.size).toBe(2);
		expect(indicators.get('a')?.parts).toEqual([
			{ category: 'Maison', amountCents: -3000 },
			{ category: 'Transport', amountCents: -1000 }
		]);
		expect(indicators.get('b')?.parts).toEqual([
			{ category: 'Loisirs', amountCents: -700 },
			{ category: 'Transport', amountCents: -800 }
		]);
	});

	it('agrees with splitIndicatorOf on the transaction it describes', () => {
		expect.assertions(1);

		// The oracle CALLS the canonical rule instead of restating what it should have produced —
		// this file's own subject one level up. If the two ever disagree the wrapper has drifted, and
		// that is the only thing this assertion is about.
		const own = [alloc('a', 'Maison', -3000), alloc('a', 'Maison', -2000)];
		const indicators = splitIndicatorsByTransactionId([...own, alloc('b', 'Loisirs', -700)]);

		expect(indicators.get('a')).toEqual(splitIndicatorOf(own));
	});

	it('omits a transaction whose allocations do not describe a split, so "absent" means "unsplit"', () => {
		expect.assertions(3);

		// One allocation covering the whole amount is what an UNSPLIT row produces, and
		// `splitIndicatorOf` answers `null` for it. The map must not carry an entry, because every
		// call site reads `.get(id) ?? null` and an entry here would put a badge on a plain row.
		const indicators = splitIndicatorsByTransactionId([
			alloc('unsplit', 'Alimentation', -4500),
			alloc('split', 'Maison', -3000),
			alloc('split', 'Transport', -1000)
		]);

		expect(splitIndicatorOf([alloc('unsplit', 'Alimentation', -4500)])).toBeNull();
		expect(indicators.has('unsplit')).toBe(false);
		expect(indicators.has('split')).toBe(true);
	});

	it('is empty for an empty input, rather than throwing', () => {
		expect.assertions(1);
		expect(splitIndicatorsByTransactionId([]).size).toBe(0);
	});
});
