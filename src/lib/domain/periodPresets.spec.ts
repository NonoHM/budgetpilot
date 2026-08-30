import { describe, expect, it } from 'vitest';
import {
	PERIOD_PRESET_IDS,
	REPORTING_PERIOD_PRESET_IDS,
	matchPeriodPreset,
	periodKeyOfPreset,
	periodKeyOfRange,
	periodPresetRange,
	periodQueryOfRange
} from './periodPresets';

const TODAY = '2026-06-17';

describe('periodPresetRange', () => {
	it('this month spans the whole calendar month', () => {
		expect(periodPresetRange('thisMonth', TODAY)).toEqual({
			from: '2026-06-01',
			to: '2026-06-30'
		});
	});

	it('last month crosses the year boundary correctly in January', () => {
		expect(periodPresetRange('lastMonth', '2026-01-09')).toEqual({
			from: '2025-12-01',
			to: '2025-12-31'
		});
	});

	it('last 30 days is inclusive of today, so it spans 30 days and not 31', () => {
		// TODAY is 2026-06-17. Counting today as one of the thirty puts the start on 2026-05-19.
		expect(periodPresetRange('last30Days', TODAY)).toEqual({
			from: '2026-05-19',
			to: '2026-06-17'
		});
	});

	it('last 30 days crosses a DST boundary without shifting by one', () => {
		// Europe's spring-forward is the last Sunday of March. A local-time implementation of
		// "today minus 29 days" loses an hour here and lands on the wrong calendar day.
		expect(periodPresetRange('last30Days', '2026-04-05')).toEqual({
			from: '2026-03-07',
			to: '2026-04-05'
		});
	});

	it('this quarter is the whole calendar quarter, not a window ending today', () => {
		// June is in Q2, so the range is April 1 to June 30 — it does NOT stop at TODAY, unlike the
		// two rolling presets. Same rule as thisMonth and thisYear.
		expect(periodPresetRange('thisQuarter', TODAY)).toEqual({
			from: '2026-04-01',
			to: '2026-06-30'
		});
	});

	it('this quarter lands on the right quarter at every boundary', () => {
		expect(periodPresetRange('thisQuarter', '2026-01-01')).toEqual({
			from: '2026-01-01',
			to: '2026-03-31'
		});
		expect(periodPresetRange('thisQuarter', '2026-03-31')).toEqual({
			from: '2026-01-01',
			to: '2026-03-31'
		});
		expect(periodPresetRange('thisQuarter', '2026-07-01')).toEqual({
			from: '2026-07-01',
			to: '2026-09-30'
		});
		expect(periodPresetRange('thisQuarter', '2026-12-31')).toEqual({
			from: '2026-10-01',
			to: '2026-12-31'
		});
	});

	it('offers exactly the six presets the design preset block can hold', () => {
		// Six is a layout constraint: 102px of preset budget is three 30px rows plus two 6px gaps,
		// in two columns. A seventh moves the panel off its specified height, so this asserts the
		// COUNT as well as the membership.
		expect(PERIOD_PRESET_IDS).toHaveLength(6);
		expect([...PERIOD_PRESET_IDS]).toEqual([
			'thisMonth',
			'lastMonth',
			'last30Days',
			'thisQuarter',
			'thisYear',
			'last12Months'
		]);
	});

	it('last 12 months ends today and starts eleven whole months back', () => {
		expect(periodPresetRange('last12Months', TODAY)).toEqual({
			from: '2025-07-01',
			to: '2026-06-17'
		});
	});

	it('this year spans 1 January to 31 December', () => {
		expect(periodPresetRange('thisYear', TODAY)).toEqual({
			from: '2026-01-01',
			to: '2026-12-31'
		});
	});

	it('handles a February 29 in a leap year', () => {
		expect(periodPresetRange('thisMonth', '2024-02-05')).toEqual({
			from: '2024-02-01',
			to: '2024-02-29'
		});
	});

	// Boundary cases the plan omits.

	it('last month from 31 March lands on a shorter month (28 days, non-leap year)', () => {
		// March 2026 -> last month is February 2026, and 2026 is not a leap year (28 days).
		expect(periodPresetRange('lastMonth', '2026-03-31')).toEqual({
			from: '2026-02-01',
			to: '2026-02-28'
		});
	});

	it('this month on the last day of the month still ends on that same last day', () => {
		// April has 30 days, and the 30th IS the last day.
		expect(periodPresetRange('thisMonth', '2026-04-30')).toEqual({
			from: '2026-04-01',
			to: '2026-04-30'
		});
	});

	it('last 12 months crossing a leap day includes February 2024 in full', () => {
		// From January 2025, eleven whole months back is February 2024 (a leap year), so the
		// range fully contains 2024-02-29 without the arithmetic ever naming it explicitly.
		expect(periodPresetRange('last12Months', '2025-01-15')).toEqual({
			from: '2024-02-01',
			to: '2025-01-15'
		});
	});
});

describe('matchPeriodPreset', () => {
	it('round-trips every preset', () => {
		for (const id of PERIOD_PRESET_IDS) {
			expect(matchPeriodPreset(periodPresetRange(id, TODAY), TODAY)).toBe(id);
		}
	});

	it('returns null for a hand-typed range that matches no preset', () => {
		expect(matchPeriodPreset({ from: '2026-03-03', to: '2026-06-12' }, TODAY)).toBeNull();
	});

	it('returns null for an empty range', () => {
		expect(matchPeriodPreset({ from: '', to: '' }, TODAY)).toBeNull();
	});
});

describe('the reporting preset set', () => {
	// Separates "the dashboard and /reports get their own preset list" from "every caller gets
	// the /transactions list". Under one shared list this file cannot express set B at all.
	it('is the five the dashboard and /reports carry, in the order they are read', () => {
		expect([...REPORTING_PERIOD_PRESET_IDS]).toEqual([
			'thisMonth',
			'lastMonth',
			'last30Days',
			'last90Days',
			'allTime'
		]);
	});

	// Separates "a set fits the 102px preset block" from "a set overflows it and moves the panel
	// off its specified height". The budget is on the COUNT, so the count is what is asserted,
	// for BOTH sets rather than for the one that happens to be shorter.
	it('fits the same three-row layout budget as the /transactions set', () => {
		expect(PERIOD_PRESET_IDS.length).toBeLessThanOrEqual(6);
		expect(REPORTING_PERIOD_PRESET_IDS.length).toBeLessThanOrEqual(6);
	});
});

describe('periodKeyOfPreset', () => {
	// THE test of this change. Separates "an applied preset serialises as ?period=this-month" from
	// "it flattens to ?period=custom&from=...&to=...". The second is what deletes comparisonMonth
	// from both screens, because date-range.ts derives that from the KEY and never from the range.
	it('gives every reporting preset the named key the URL carries', () => {
		expect(REPORTING_PERIOD_PRESET_IDS.map(periodKeyOfPreset)).toEqual([
			'this-month',
			'last-month',
			'last-30-days',
			'last-90-days',
			'all-time'
		]);
	});

	// Separates "a preset with no named key says so" from "it invents one". The three
	// /transactions-only presets have no `period=` spelling, and a caller that serialises must be
	// able to tell that apart from a key it has not handled yet.
	it('returns null for the presets that exist only on /transactions', () => {
		expect(periodKeyOfPreset('thisQuarter')).toBeNull();
		expect(periodKeyOfPreset('thisYear')).toBeNull();
		expect(periodKeyOfPreset('last12Months')).toBeNull();
	});
});

describe('matchPeriodPreset over a caller-chosen set', () => {
	// Separates "matching honours the set the caller mounted" from "matching always walks set A".
	// The control is the same range under the default set: it must NOT light, because allTime is
	// not in that set, and without the control a passing first line proves nothing.
	it('lights allTime for the epoch range under the reporting set, and nothing under the default', () => {
		const allTime = periodPresetRange('allTime', TODAY);

		expect(matchPeriodPreset(allTime, TODAY, REPORTING_PERIOD_PRESET_IDS)).toBe('allTime');
		expect(matchPeriodPreset(allTime, TODAY)).toBeNull();
	});

	it('round-trips every reporting preset', () => {
		for (const id of REPORTING_PERIOD_PRESET_IDS) {
			expect(
				matchPeriodPreset(periodPresetRange(id, TODAY), TODAY, REPORTING_PERIOD_PRESET_IDS)
			).toBe(id);
		}
	});
});

describe('periodKeyOfRange', () => {
	// The brick the dashboard and /reports both serialise through, so that "which period is this"
	// is answered in ONE place rather than once per screen. It separates "an applied range that IS
	// a named period serialises under that name" from "every applied range becomes ?period=custom".
	it('names a range that is a preset, and falls back to custom for one that is not', () => {
		const set = REPORTING_PERIOD_PRESET_IDS;

		expect(periodKeyOfRange(periodPresetRange('thisMonth', TODAY), TODAY, set)).toBe('this-month');
		expect(periodKeyOfRange(periodPresetRange('allTime', TODAY), TODAY, set)).toBe('all-time');
		expect(periodKeyOfRange({ from: '2026-03-03', to: '2026-06-12' }, TODAY, set)).toBe('custom');
	});

	// Separates "the set is honoured" from "the set argument is accepted and ignored". allTime is a
	// real preset with a real key, so a call that omits its set must still come back custom: the
	// range is not one of the six /transactions offers. Without this the previous test would pass
	// against an implementation that ignored `presets` entirely.
	it('does not name a preset that the caller-chosen set does not contain', () => {
		expect(periodKeyOfRange(periodPresetRange('allTime', TODAY), TODAY)).toBe('custom');
	});

	// Separates "the answer follows the set the screen mounted" from "it follows set A". A quarter
	// is a real preset on /transactions and has no `period=` spelling at all, so under the default
	// set it must still come back as custom rather than as a key nobody can parse.
	it('returns custom for a preset that has no named key', () => {
		expect(periodKeyOfRange(periodPresetRange('thisQuarter', TODAY), TODAY)).toBe('custom');
	});
});

describe('periodQueryOfRange', () => {
	const set = REPORTING_PERIOD_PRESET_IDS;

	// One serialiser for both screens, so the dashboard and /reports cannot spell the same period
	// two ways. Separates "a named period keeps its name in the URL" from "every applied range is
	// written out as a pair of dates".
	it('writes a named period as its key alone, with no from or to', () => {
		expect(periodQueryOfRange(periodPresetRange('thisMonth', TODAY), TODAY, set)).toBe(
			'period=this-month'
		);
		expect(periodQueryOfRange(periodPresetRange('allTime', TODAY), TODAY, set)).toBe(
			'period=all-time'
		);
	});

	// Separates "a hand-typed range carries its bounds" from "it is written as a bare
	// period=custom", which is the shape that renders the error page (#548).
	it('writes a range that is no preset as custom, with both bounds', () => {
		expect(periodQueryOfRange({ from: '2026-03-03', to: '2026-06-12' }, TODAY, set)).toBe(
			'period=custom&from=2026-03-03&to=2026-06-12'
		);
	});
});
