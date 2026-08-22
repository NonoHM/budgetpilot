import { describe, expect, it } from 'vitest';
import { assignDedupeKeys } from './dedupeRecompute';
import { computeDedupeKeyHash, computeNullableDedupeKeyHash, dedupeKeyUpdate } from './dedupeKey';

describe('computeDedupeKeyHash', () => {
	it('is stable and always 64 hex characters', () => {
		expect.assertions(2);

		const hash = computeDedupeKeyHash('2026-06-01|carrefour market|-4210|expense||');

		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hash).toBe(computeDedupeKeyHash('2026-06-01|carrefour market|-4210|expense||'));
	});

	it('separates keys differing only by an accent', () => {
		expect.assertions(1);

		// The reason this column exists. MySQL and MariaDB default to accent-insensitive
		// collations, where these two keys compare equal in SQL: one of the two transactions
		// would be swallowed as a duplicate of the other.
		expect(computeDedupeKeyHash('2026-06-01|cafe|-350|expense||')).not.toBe(
			computeDedupeKeyHash('2026-06-01|café|-350|expense||')
		);
	});

	it('separates long keys that differ only past the 191st character', () => {
		expect.assertions(1);

		// The other reason. A String under a unique index is varchar(191) by default on
		// MySQL, so an index seeing only a prefix merges rows that differ after it.
		const prefix = 'x'.repeat(200);
		expect(computeDedupeKeyHash(`${prefix}|first`)).not.toBe(
			computeDedupeKeyHash(`${prefix}|second`)
		);
	});

	it('separates two real keys differing only by their label case and accents', () => {
		expect.assertions(1);

		// Built through the real generator, so the guarantee is asserted end to end rather
		// than on hand-written strings.
		const row = {
			id: 'r',
			source: 'csv',
			accountId: 'acc',
			date: '2026-06-01',
			amountCents: -350,
			type: 'expense' as const,
			currency: 'EUR',
			exponent: 2,
			providerAccountId: null,
			entryReference: null,
			keyed: true
		};
		const left = assignDedupeKeys([{ ...row, label: 'Café de la Gare' }]).get('r')!;
		const right = assignDedupeKeys([{ ...row, label: 'Cafe de la Gare' }]).get('r')!;

		expect(computeDedupeKeyHash(left)).not.toBe(computeDedupeKeyHash(right));
	});
});

describe('computeNullableDedupeKeyHash', () => {
	it.each([
		['null', null],
		['undefined', undefined],
		['an empty string', '']
	])('returns null for %s', (_label, value) => {
		expect.assertions(1);

		expect(computeNullableDedupeKeyHash(value)).toBeNull();
	});
});

describe('dedupeKeyUpdate', () => {
	it('writes the raw key and its hash together', () => {
		expect.assertions(1);

		expect(dedupeKeyUpdate('dedupe-1')).toEqual({
			dedupeKey: 'dedupe-1',
			dedupeKeyHash: computeDedupeKeyHash('dedupe-1')
		});
	});

	it('nulls both columns when there is no key', () => {
		expect.assertions(1);

		// An empty key is "no key", not a key whose value is the empty string: hashing that
		// would make every keyless row a duplicate of every other keyless row.
		expect(dedupeKeyUpdate('')).toEqual({ dedupeKey: null, dedupeKeyHash: null });
	});
});
