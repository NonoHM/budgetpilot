import { describe, expect, it } from 'vitest';
import {
	isStorableIsoDate,
	isStorableYear,
	validateTransaction,
	type Transaction
} from './transaction';

/**
 * #758: the range of years a date may carry into a `DateTime` column, decided once.
 *
 * The boundaries are asserted as LITERALS on purpose, one on each side of each bound, because the
 * bound is a ruling (the PR body records the evidence: what all three engines store and read back
 * unchanged, and what Actual Budget and Firefly III accept) and the four literals are the single
 * value per side where `<` and `<=` disagree. A bound moved by one year reddens exactly one of them.
 *
 * Breaks, each run separately:
 * - lower bound 1000 -> 1001: red on « 1000 is storable » (separates « first storable year
 *   included » from « excluded »).
 * - lower bound 1000 -> 999: red on « 999 is not storable » (separates « 0999 refused » from
 *   « 0999 admitted », the year the parser reaches and MariaDB's documented range does not cover).
 * - upper bound 9999 -> 9998: red on « 9999 is storable ».
 * - upper bound 9999 -> 10000: red on « 10000 is not storable » (reachable on a restore, where
 *   `Date.parse` admits `+010000-01-01`; PostgreSQL then reads it back as an Invalid Date).
 */
describe('isStorableYear', () => {
	it.each([
		{ year: 0, storable: false },
		{ year: 1, storable: false },
		{ year: 99, storable: false },
		{ year: 999, storable: false },
		{ year: 1000, storable: true },
		{ year: 2026, storable: true },
		{ year: 9999, storable: true },
		{ year: 10000, storable: false },
		{ year: Number.NaN, storable: false },
		{ year: 1999.5, storable: false }
	])('$year is storable: $storable', ({ year, storable }) => {
		expect.assertions(1);
		expect(isStorableYear(year)).toBe(storable);
	});
});

describe('isStorableIsoDate', () => {
	/**
	 * Separates « the year of a VALID date is judged » from « the string is judged some other way »:
	 * `0000-01-16` is a calendar-valid ISO date (`isValidIsoDate` accepts it, and did on the day
	 * #758 was measured), so a predicate that only checked the calendar answers `true` here.
	 */
	it.each([
		{ value: '0000-01-16', storable: false },
		{ value: '0001-01-01', storable: false },
		{ value: '0050-06-15', storable: false },
		{ value: '0999-12-31', storable: false },
		{ value: '1000-01-01', storable: true },
		{ value: '2000-02-29', storable: true },
		{ value: '9999-12-31', storable: true },
		// Not a date at all: storable is a property of dates, never true of a non-date.
		{ value: '2026-13-45', storable: false },
		{ value: 'CARD_PAYMENT', storable: false }
	])('$value is storable: $storable', ({ value, storable }) => {
		expect.assertions(1);
		expect(isStorableIsoDate(value)).toBe(storable);
	});
});

describe('validateTransaction refuses a year no engine stores faithfully', () => {
	const base: Transaction = {
		id: 'manual-1',
		date: '2026-08-01',
		label: 'SUPERETTE',
		amountCents: -1234,
		type: 'expense',
		category: 'Alimentation',
		source: 'manual'
	};

	/**
	 * The manual entry path writes through `validateTransaction` alone, and a date input admits
	 * year 0050, which MariaDB reads back as 1950 (#758's measurement). Separates « refused with
	 * the range code » from « accepted », and from « refused as an invalid date », which would tell
	 * the user their valid calendar date is malformed.
	 */
	it('names date-out-of-range, and not invalid-iso-date, for a calendar-valid year 0050', () => {
		expect.assertions(1);
		expect(validateTransaction({ ...base, date: '0050-06-15' })).toEqual({
			ok: false,
			violations: ['date-out-of-range']
		});
	});

	it('names invalid-iso-date, and not date-out-of-range, for a date that is not one', () => {
		expect.assertions(1);
		expect(validateTransaction({ ...base, date: '2026-13-45' })).toEqual({
			ok: false,
			violations: ['invalid-iso-date']
		});
	});

	it('accepts the first storable day', () => {
		expect.assertions(1);
		expect(validateTransaction({ ...base, date: '1000-01-01' })).toEqual({ ok: true });
	});
});
