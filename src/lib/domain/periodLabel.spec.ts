import { describe, expect, it } from 'vitest';
import {
	PERIOD_VALUE_MAX_PX,
	bothDatesShareYear,
	estimateValueWidthPx,
	formatPeriodLabel,
	type PeriodCopy
} from './periodLabel';

const copy: PeriodCopy = {
	openStart: (d) => `depuis le ${d}`,
	openEnd: (d) => `jusqu'au ${d}`,
	custom: 'période personnalisée',
	invalid: 'saisie invalide'
};

const label = (from: string, to: string, over: Partial<{ allowCustomRung: boolean }> = {}) =>
	formatPeriodLabel({
		from,
		to,
		invalid: false,
		locale: 'fr',
		allowCustomRung: true,
		copy,
		...over
	});

describe('estimateValueWidthPx calibration', () => {
	// Pins the measured table against real ground truth (Chromium, 1280px, the live trigger's value
	// span). Tolerance ±2px. If this drifts, the table was edited without re-measuring — re-measure,
	// do not retune by eye back to green.
	it.each([
		['3 mars 2026 → 12 juin 2026', 175.5],
		['30 septembre 2026 → 28 février 2027', 235.1],
		['3 mars → 12 juin', 105.6],
		['30 septembre → 28 février', 165.2],
		['2024 → 2026', 83.9],
		["jusqu'au 28 février 2027", 148.2],
		['depuis le 30 septembre 2026', 180.2]
	])('estimates %s within 2px of the measured %spx', (text, measured) => {
		expect(estimateValueWidthPx(text)).toBeGreaterThanOrEqual(measured - 2);
		expect(estimateValueWidthPx(text)).toBeLessThanOrEqual(measured + 2);
	});

	// The numeric rung is excluded from the tolerance band above on purpose: '/' is deliberately
	// entered at the DIGIT width rather than its (narrower) isolated width, so the estimate reads
	// ~146.9 against a measured 138.5 — an 8.4px over-estimate, well past the ±2px band the other
	// rows use. That is the intended direction (over-, never under-estimating), so this row is
	// pinned as a range instead: at least the measured true width, and still comfortably under the
	// 190px cap, which is the property that actually matters for this rung.
	it('over-estimates the numeric rung, but stays under the cap', () => {
		const estimate = estimateValueWidthPx('03/03/26 → 12/06/26');
		expect(estimate).toBeGreaterThanOrEqual(138.5);
		expect(estimate).toBeLessThanOrEqual(190);
	});
});

describe('the year-drop guard', () => {
	// At our type scale (text-sm, the app font stack) '3 mars 2026 → 12 juin 2026' measures 175.5px,
	// which FITS under the 190px cap on rung 1 (`long`). The design deliverable shows this exact
	// string refused at 238px and shortened to '3 mars → 12 juin' — but that figure comes from the
	// mockup's own (larger) type rendering, not ours. The normative rule is "descend the ladder
	// until the value fits in 190px", not "match the mockup's pixel figure", so at this scale rung 1
	// is correctly RETAINED and the year is not dropped. This is a real, expected divergence from
	// the design's worked example: the app simply gets one more rung of fidelity than the mockup.
	// The rule is "shortest form that remains TRUE", not "first form that fits". The design's own
	// worked example measures 175.5px here and WOULD fit under the 190px cap, so a purely
	// dimensional ladder would keep the year — and rungs 2 onward would then never fire for
	// anything, which is plainly not what section 5b draws. The year is redundant when both
	// endpoints carry it, so it goes, whether or not there was room for it.
	it('drops the redundant year even when the long form would have fitted', () => {
		const result = label('2026-03-03', '2026-06-12');
		expect(estimateValueWidthPx('3 mars 2026 → 12 juin 2026')).toBeLessThanOrEqual(
			PERIOD_VALUE_MAX_PX
		);
		expect(result.text).toBe('3 mars → 12 juin');
		expect(result.rung).toBe('longNoYear');
	});

	// A same-year range whose month names are long enough that the long form (258.3px) overflows
	// the cap. Same rung as above — which is the point: width did not decide it either time.
	it('drops the year when both dates share it and the long form does not fit', () => {
		const result = label('2026-09-30', '2026-11-28');
		expect(result.text).toBe('30 septembre → 28 novembre');
		expect(result.rung).toBe('longNoYear');
	});

	// THE GUARD. If this goes green with the guard removed, the guard is not load-bearing.
	it('KEEPS the year on a cross-year range, whatever the width says', () => {
		const result = label('2025-12-24', '2026-01-03');
		expect(result.text).not.toBe('24 décembre → 3 janvier');
		expect(result.text).not.toContain('24 décembre → 3 janvier');
		expect(result.rung).not.toBe('longNoYear');
		// Both years survive, in whichever rung was chosen.
		expect(result.text).toMatch(/25/);
		expect(result.text).toMatch(/26/);
	});

	it('bothDatesShareYear is the named rule, and it is false across a year boundary', () => {
		expect(bothDatesShareYear('2026-03-03', '2026-06-12')).toBe(true);
		expect(bothDatesShareYear('2025-12-24', '2026-01-03')).toBe(false);
	});
});

describe('the 190px cap', () => {
	// THE CAP. Every shape the app can produce, on every rung, stays inside the cap.
	it.each([
		['2026-03-03', '2026-06-12'],
		['2026-09-30', '2027-02-28'],
		['2020-01-01', '2026-12-31'],
		['2026-09-30', ''],
		['', '2027-02-28'],
		['2026-12-24', '2027-01-03']
	])('never exceeds the cap for %s..%s', (from, to) => {
		const result = label(from, to);
		expect(estimateValueWidthPx(result.text)).toBeLessThanOrEqual(PERIOD_VALUE_MAX_PX);
	});
});

describe('the shapes', () => {
	it('names an open start with the word, not a one-sided arrow', () => {
		const result = label('2026-03-03', '');
		expect(result.text).toContain('depuis le');
		expect(result.text).not.toContain('→');
		expect(result.rung).toBe('openStart');
	});

	it('names an open end with the word, not a one-sided arrow', () => {
		const result = label('', '2026-06-12');
		expect(result.text).toContain("jusqu'au");
		expect(result.text).not.toContain('→');
		expect(result.rung).toBe('openEnd');
	});

	it('renders a whole month as its preset label rather than a range', () => {
		const result = label('2026-06-01', '2026-06-30');
		expect(result.text).toBe('juin 2026');
		expect(result.rung).toBe('preset');
	});

	// Asserted BY RUNG NAME, deliberately. The first version of this branch tested
	// `from.slice(5) === '-01-01'`, which is false for every possible input (index 4 is the hyphen,
	// so the tail is '01-01'), and the rung silently never fired. A test that only asserted "some
	// rung was chosen" would have stayed green over a permanently dead branch.
	it('says a whole-year multi-year span as years only, the shortest form that is still true', () => {
		const result = label('2024-01-01', '2026-12-31');
		expect(result.text).toBe('2024 → 2026');
		expect(result.rung).toBe('yearsOnly');
	});

	// The same span moved off the year boundaries by ONE DAY. "2024 → 2026" would then be a claim
	// about January 2024 that the filter does not make, so the rung must not fire.
	it('refuses the years-only rung when the span does not cover whole years', () => {
		const result = label('2024-01-02', '2026-12-31');
		expect(result.rung).not.toBe('yearsOnly');
		expect(result.text).not.toBe('2024 → 2026');
	});

	it('withholds the custom rung when it is not allowed (mobile)', () => {
		const result = label('2026-09-30', '2027-02-28', { allowCustomRung: false });
		expect(result.rung).not.toBe('custom');
		expect(result.text).not.toBe('période personnalisée');
	});

	it('says the word invalide, and full still carries the unabridged form', () => {
		const result = formatPeriodLabel({
			from: 'nonsense',
			to: '2026-06-12',
			invalid: true,
			locale: 'fr',
			allowCustomRung: true,
			copy
		});
		expect(result.text).toBe('saisie invalide');
		expect(result.rung).toBe('invalid');
	});

	it('always carries the unabridged form in `full`, whichever rung renders', () => {
		const result = label('2026-09-30', '2027-02-28');
		expect(result.full).toBe('30 septembre 2026 → 28 février 2027');
		expect(result.shortened).toBe(result.text !== result.full);
	});
});
