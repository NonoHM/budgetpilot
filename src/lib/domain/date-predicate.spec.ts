import { describe, expect, it } from 'vitest';
import { isValidIsoDate } from './transaction';
import { parseCsvTransactions } from '$lib/server/import/csv';
import { BANQUE_POPULAIRE_HEADERS } from '$lib/server/import/profiles/banque-populaire';

/**
 * `isValidIsoDate` is a PREDICATE, and this file exists because it used not to behave like one:
 * `ISO_DATE_PATTERN` admits `2026-13-45`, `new Date(...)` answers an Invalid Date, and
 * `Invalid Date.toISOString()` raises `RangeError: Invalid time value` rather than returning a
 * sentinel. Four of the five import profiles carried a local `isSafeIsoDate` try/catch around it;
 * `banque-populaire` did not, and answered 500 on an upload that should have been refused by line.
 *
 * The first test is the one that would have caught it on its first day, and it is exhaustive
 * rather than sampled on purpose: the domain is 10000 strings, so there is no reason to guess
 * which ones matter. `2026-02-30` in particular answers `false` WITHOUT throwing, because
 * JavaScript rolls it over to March 2, so a spec that reached for one obviously-silly date would
 * have picked the one case that cannot fail.
 *
 * Kept separate from `transaction.spec.ts` because it deliberately crosses layers: the predicate
 * and the import profile that consumes it are one defect, and a test on either alone leaves the
 * other free to reintroduce it.
 */
describe('isValidIsoDate is a predicate, not a thrower', () => {
	it('returns a boolean for every string its own pattern admits, and throws for none', () => {
		expect.assertions(3);

		const throwers: string[] = [];
		let trueCount = 0;
		let total = 0;

		for (let month = 0; month <= 99; month += 1) {
			for (let day = 0; day <= 99; day += 1) {
				const value = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
				total += 1;
				try {
					if (isValidIsoDate(value)) trueCount += 1;
				} catch {
					throwers.push(value);
				}
			}
		}

		expect(total).toBe(10_000);
		// Named rather than counted: a count of 0 is what an empty loop also reports.
		expect(throwers).toStrictEqual([]);
		// 2026 is not a leap year. The absolute figure is what proves the loop ran and that the
		// predicate still says yes to something: `throwers` being empty is satisfied by a
		// predicate that returns false for everything.
		expect(trueCount).toBe(365);
	});

	it('accepts the real calendar and refuses the rollovers, without a throw in either direction', () => {
		expect.assertions(6);

		expect(isValidIsoDate('2026-12-31')).toBe(true);
		expect(isValidIsoDate('2026-01-31')).toBe(true);
		// The two shapes the old code could not tell apart: one rolled over silently and answered
		// false, the other produced an Invalid Date and raised.
		expect(isValidIsoDate('2026-02-30')).toBe(false);
		expect(isValidIsoDate('2026-13-01')).toBe(false);
		expect(isValidIsoDate('2026-01-32')).toBe(false);
		expect(isValidIsoDate('2026-00-00')).toBe(false);
	});

	it('refuses a string that does not match the pattern at all', () => {
		expect.assertions(4);

		expect(isValidIsoDate('')).toBe(false);
		expect(isValidIsoDate('02/01/2026')).toBe(false);
		expect(isValidIsoDate('2026-1-2')).toBe(false);
		expect(isValidIsoDate('2026-01-02T00:00:00Z')).toBe(false);
	});
});

/**
 * The consumer half. `banque-populaire` is the profile that reached the predicate unguarded, so
 * it is the one whose refusal has to be pinned; the other four went through a wrapper that has
 * since been deleted as redundant, and would have stayed green through the whole defect.
 */
describe('the import profile that reached it unguarded', () => {
	const header = BANQUE_POPULAIRE_HEADERS.join(';');
	const row = (date: string) =>
		[
			date,
			'Carrefour',
			'CB CARREFOUR',
			'REF1',
			'',
			'CB',
			'Courses',
			'',
			'-45,00',
			'',
			date,
			date,
			''
		].join(';');

	it('refuses an out-of-range date by line and reason, rather than raising', () => {
		expect.assertions(3);

		const result = parseCsvTransactions([header, row('2026-13-45')].join('\n'));

		expect(result.transactions).toHaveLength(0);
		// The REASON, not merely that something was refused: before the fix this row did not
		// produce a refusal at all, and any assertion phrased as "no transactions" would have
		// been satisfied by the RangeError never being caught in the first place.
		//
		// The wording is « date ISO invalide » and not « date invalide » because this profile has
		// no pre-check of its own: the refusal arrives from `validateTransaction` rather than from
		// the profile, which is the same absence that let the throw escape. The other four
		// profiles say « date invalide ». Not reconciled here, and noted so the difference reads
		// as a measurement rather than a typo.
		expect(result.errors.join(' ')).toContain('date ISO invalide');
		expect(result.invalidRows[0]?.line).toBe(2);
	});

	it('still accepts a real date, so the refusal above is about the date and not the fixture', () => {
		expect.assertions(2);

		const result = parseCsvTransactions([header, row('2026-03-15')].join('\n'));

		expect(result.errors).toStrictEqual([]);
		expect(result.transactions).toHaveLength(1);
	});
});
