import { describe, expect, it } from 'vitest';
import { toMinorUnits, toNullableMinorUnits } from './minorUnits.ts';

describe('toMinorUnits', () => {
	it('returns a number for a bigint inside the exact range', () => {
		expect.assertions(2);

		const value = toMinorUnits(10_000_000_000n, 'Transaction.amountCents');

		expect(typeof value).toBe('number');
		expect(value).toBe(10_000_000_000);
	});

	it('passes a plain number straight through', () => {
		expect.assertions(1);

		// SQLite hands back a number for values a number holds, and a raw query hands back whatever
		// the driver made of it. Both reach here, so both are the contract rather than an accident.
		expect(toMinorUnits(214_000, 'Transaction.amountCents')).toBe(214_000);
	});

	it('is exact at the largest value a number represents exactly', () => {
		expect.assertions(2);

		expect(toMinorUnits(BigInt(Number.MAX_SAFE_INTEGER), 'x')).toBe(Number.MAX_SAFE_INTEGER);
		expect(toMinorUnits(-BigInt(Number.MAX_SAFE_INTEGER), 'x')).toBe(-Number.MAX_SAFE_INTEGER);
	});

	// The boundary is tested ON the boundary: one unit past is the single value where refusing and
	// converting disagree, and it is exactly where the conversion stops being lossless.
	it('refuses one unit past the exact range, in both directions, naming the field', () => {
		expect.assertions(3);

		const over = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

		expect(() => toMinorUnits(over, 'NetWorthSnapshot.balanceCents')).toThrow(
			/NetWorthSnapshot\.balanceCents/
		);
		expect(() => toMinorUnits(-over, 'NetWorthSnapshot.balanceCents')).toThrow(/exactly/);
		// And the amount itself, because a refusal that does not say which value it refused sends
		// whoever reads the log back to the database to find out.
		expect(() => toMinorUnits(over, 'x')).toThrow(String(over));
	});

	it('carries null through, because an aggregate over no rows is null', () => {
		expect.assertions(2);

		expect(toNullableMinorUnits(null, 'x')).toBeNull();
		expect(toNullableMinorUnits(5n, 'x')).toBe(5);
	});
});
