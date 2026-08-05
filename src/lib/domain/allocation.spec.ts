import { describe, it, expect } from 'vitest';
import { allocationsOf } from './allocation';
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
