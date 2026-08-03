import { describe, expect, it } from 'vitest';
import { PERIOD_PRESET_IDS, matchPeriodPreset, periodPresetRange } from './periodPresets';

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

	it('last 3 months ends today and starts two whole months back', () => {
		expect(periodPresetRange('last3Months', TODAY)).toEqual({
			from: '2026-04-01',
			to: '2026-06-17'
		});
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
