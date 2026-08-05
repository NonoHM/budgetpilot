import { describe, it, expect } from 'vitest';
import { allocationsOf, distributeEvenly } from './allocation';
import type { Transaction } from './transaction';

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
