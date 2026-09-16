import { describe, expect, it } from 'vitest';
import { formatReadingDate } from './dateFormat';

/**
 * The FIRST tests this module has had, which is why the file is new rather than extended.
 *
 * `formatShortDate` and `formatMonthLabel` are exercised only through four callers' own specs. That
 * is left alone here: adding coverage for them is a separate change, and this file covers the one
 * function whose contract differs from theirs on purpose.
 */
describe('formatReadingDate', () => {
	/**
	 * Separates « a converted date a user can check against their statement » from
	 * `formatShortDate`'s display form, which abbreviates the month and SUPPRESSES the year in the
	 * current year. The reading pair exists so someone can verify that `03/04/2026` really became
	 * 3 April, and an abbreviated, year-less date cannot be checked against anything.
	 */
	it('writes the month in full and always shows the year', () => {
		expect.assertions(2);
		expect(formatReadingDate('2026-04-03', 'fr-FR')).toBe('3 avril 2026');
		expect(formatReadingDate('2026-04-03', 'en-GB')).toBe('3 April 2026');
	});

	/**
	 * Separates « the day the file names » from « that day shifted by the reader's own timezone ».
	 *
	 * `formatShortDate` deliberately pins no zone, and its docstring records that as matching the
	 * behaviour it was extracted from. On a display date that is cosmetic. On a conversion the user
	 * is being asked to CONFIRM it is the whole question: a reader west of Greenwich would be shown
	 * 2 April for a row the import stored as the 3rd, and would confirm a reading against a date the
	 * application never used.
	 *
	 * ## THE ZONE IS SET INSIDE THE TEST, AND WITHOUT THAT THIS TEST CANNOT FAIL
	 *
	 * Written first as an assertion under the runner's own zone, it passed with the UTC pin REMOVED.
	 * This machine and CI both run east of Greenwich, where UTC midnight is the same calendar day
	 * locally, so an unpinned formatter is indistinguishable from a pinned one and the test was
	 * asserting nothing. Node re-reads `process.env.TZ` when it is assigned, so the zone is moved to
	 * one where the two answers differ, which is the only arrangement in which this can redden.
	 *
	 * Restored in a `finally`: a test that leaves the process in another zone changes every test
	 * that runs after it, which is this repository's recorded clock-pinning failure with a different
	 * global.
	 */
	it('names the file own day even for a reader west of Greenwich', () => {
		expect.assertions(2);
		const original = process.env.TZ;
		try {
			process.env.TZ = 'Pacific/Honolulu';

			// The planted positive: an unpinned formatter over the same instant really does move in
			// this zone, so a green below is the pin working rather than the zone never shifting.
			const unpinned = new Date('2026-04-03T00:00:00.000Z').toLocaleDateString('fr-FR', {
				day: 'numeric',
				month: 'long',
				year: 'numeric'
			});
			expect(unpinned).toBe('2 avril 2026');

			expect(formatReadingDate('2026-04-03', 'fr-FR')).toBe('3 avril 2026');
		} finally {
			process.env.TZ = original;
		}
	});

	/**
	 * Separates « the year is always present » from « it is present because the fixture is not this
	 * year ». `formatShortDate` decides that by reading the CLOCK, so a test written in 2026 against
	 * a 2026 date proves nothing about a 2027 reader. This one asserts a date in the current year,
	 * where the short formatter would drop the year and this one must not.
	 */
	it('shows the year even for a date in the current year', () => {
		expect.assertions(1);
		const thisYear = new Date().getUTCFullYear();
		expect(formatReadingDate(`${thisYear}-04-03`, 'fr-FR')).toBe(`3 avril ${thisYear}`);
	});
});
