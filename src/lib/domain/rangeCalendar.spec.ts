import { describe, expect, it } from 'vitest';
import {
	RANGE_CALENDAR_SIZES,
	RANGE_CALENDAR_STROKES,
	boundRadiusFor,
	boundRadiusRatio,
	dayAccessibleName,
	inclusiveDayCount,
	rangeStatusSentence,
	reopeningMonthAnchor,
	type RangeCalendarCopy
} from './rangeCalendar';
import { PERIOD_EPOCH_FLOOR } from './periodPresets';

/** Deliberately not the app's real messages: these assert SHAPE, not French. */
const copy: RangeCalendarCopy = {
	rangeStart: 'debut de la plage',
	rangeEnd: 'fin de la plage',
	awaitingEnd: ({ date }) => `Debut au ${date}. Choisissez la fin.`,
	rangeSelected: ({ from, to, days }) => `Du ${from} au ${to}, ${days} jours.`,
	empty: 'Aucune periode'
};

describe('the geometry table', () => {
	/**
	 * The design's central claim about this component is not "the cell is 30px", it is "these three
	 * numbers move between the sizes and these five do not". Asserting the claim whole is the only
	 * way it can fail as a claim — a per-value test passes happily while a stroke is scaled.
	 */
	it('grows only the target, the radius and the digit between the two sizes', () => {
		const mouse = RANGE_CALENDAR_SIZES.mouse;
		const touch = RANGE_CALENDAR_SIZES.touch;

		const differing = (Object.keys(mouse) as (keyof typeof mouse)[]).filter(
			(key) => mouse[key] !== touch[key]
		);
		expect(differing.sort()).toEqual(['cell', 'digit', 'headCell', 'headDigit', 'radius'].sort());

		expect(mouse.cell).toBe(30);
		expect(touch.cell).toBe(48);
		expect(mouse.digit).toBe(12);
		expect(touch.digit).toBe(15);
	});

	it('keeps every stroke non-scaling, and the cell gap at zero', () => {
		// One shared table, so there is nowhere to put a per-size value. This asserts the VALUES so
		// that widening the type to a per-size record later still has to come past this test.
		expect(RANGE_CALENDAR_STROKES).toEqual({
			candidateDash: 1,
			todayUnderline: 2,
			focusRingInner: 2,
			focusRingOuter: 2,
			continuationDots: 2,
			cellGap: 0
		});
	});

	it('takes the bound radius from the design table, not from cell/3', () => {
		expect(boundRadiusFor('mouse')).toBe(10);
		expect(boundRadiusFor('touch')).toBe(14);

		// Pinned deliberately against the design's own stated rationale, which is arithmetically
		// wrong for the touch size: "un tiers de la cellule" gives 16 at 48px, while the conformance
		// table and the 6A state list both say 14. Deriving would ship a 16px corner. If a later
		// revision of the design really does want 16, this line is where that decision gets made
		// explicitly rather than inherited from a formula.
		expect(Math.round(RANGE_CALENDAR_SIZES.touch.cell / 3)).toBe(16);
		expect(boundRadiusFor('touch')).not.toBe(Math.round(RANGE_CALENDAR_SIZES.touch.cell / 3));
	});

	it('keeps both radii near the one-third roundness the design was reaching for', () => {
		// The property the false sentence was after, stated in a form that is actually true of both.
		expect(boundRadiusRatio('mouse')).toBeCloseTo(0.333, 2);
		expect(boundRadiusRatio('touch')).toBeCloseTo(0.292, 2);
		for (const size of ['mouse', 'touch'] as const) {
			expect(boundRadiusRatio(size)).toBeGreaterThan(0.28);
			expect(boundRadiusRatio(size)).toBeLessThan(0.35);
		}
	});

	it('keeps the cell at or above the 24px floor that legitimises a gapless grid', () => {
		// 2.5.8's spacing clause only rescues targets UNDER 24px. The design is explicit that at 23px
		// the continuous grid would fail at once, so this floor is load-bearing, not a comfort margin.
		expect(RANGE_CALENDAR_SIZES.mouse.cell).toBeGreaterThanOrEqual(24);
		expect(RANGE_CALENDAR_STROKES.cellGap).toBe(0);
	});
});

describe('inclusiveDayCount', () => {
	it('counts both bounds', () => {
		expect(inclusiveDayCount('2026-06-03', '2026-06-04')).toBe(2);
		expect(inclusiveDayCount('2026-06-03', '2026-06-18')).toBe(16);
	});

	it('counts a single day as one', () => {
		expect(inclusiveDayCount('2026-06-03', '2026-06-03')).toBe(1);
	});

	it('crosses a month, a leap day and a year without a DST term', () => {
		expect(inclusiveDayCount('2026-01-31', '2026-02-01')).toBe(2);
		expect(inclusiveDayCount('2024-02-28', '2024-03-01')).toBe(3); // 2024 is a leap year
		expect(inclusiveDayCount('2026-12-31', '2027-01-01')).toBe(2);
		// Across the European DST boundary (last Sunday of March), which a local-time
		// implementation would get wrong by one.
		expect(inclusiveDayCount('2026-03-28', '2026-03-30')).toBe(3);
	});
});

describe('dayAccessibleName', () => {
	it('names a plain day by its full date, never by the digit alone', () => {
		expect(dayAccessibleName({ longDate: 'mardi 3 juin 2026', bound: null, copy })).toBe(
			'mardi 3 juin 2026'
		);
	});

	it('says which bound a bound is', () => {
		expect(dayAccessibleName({ longDate: 'mardi 3 juin 2026', bound: 'start', copy })).toBe(
			'mardi 3 juin 2026, debut de la plage'
		);
		expect(dayAccessibleName({ longDate: 'jeudi 18 juin 2026', bound: 'end', copy })).toBe(
			'jeudi 18 juin 2026, fin de la plage'
		);
	});
});

describe('rangeStatusSentence', () => {
	it('says where it is waiting when only the start is placed', () => {
		// This is the whole of 6L's replacement for the hover preview: at 390 there is no band on
		// screen at this step, so this sentence is the only feedback that the tap was accepted.
		expect(
			rangeStatusSentence({
				from: '2026-06-03',
				to: null,
				fromLong: '3 juin 2026',
				toLong: null,
				copy
			})
		).toBe('Debut au 3 juin 2026. Choisissez la fin.');
	});

	it('states the whole range in words, with the inclusive count', () => {
		expect(
			rangeStatusSentence({
				from: '2026-06-03',
				to: '2026-06-18',
				fromLong: '3 juin 2026',
				toLong: '18 juin 2026',
				copy
			})
		).toBe('Du 3 juin 2026 au 18 juin 2026, 16 jours.');
	});

	it('falls back to the empty sentence rather than a half-built one', () => {
		expect(rangeStatusSentence({ from: null, to: null, fromLong: null, toLong: null, copy })).toBe(
			'Aucune periode'
		);
		// An end with no start is not a range and must not be narrated as one.
		expect(
			rangeStatusSentence({ from: null, to: '2026-06-18', fromLong: null, toLong: '18 juin', copy })
		).toBe('Aucune periode');
	});
});

describe('reopeningMonthAnchor', () => {
	const todayIso = '2026-08-04';

	it('opens on the start month, the anchor that does not move', () => {
		expect(
			reopeningMonthAnchor({ from: '2026-03-03', to: '2026-06-12', lastEdited: null, todayIso })
		).toBe('2026-03-03');
		expect(
			reopeningMonthAnchor({ from: '2026-03-03', to: '2026-06-12', lastEdited: 'from', todayIso })
		).toBe('2026-03-03');
	});

	it('opens on the end month when the range starts at the epoch floor', () => {
		// The all-time period has no chosen start: `?period=all-time` resolves to the epoch, so anchoring
		// on the start would open the grid on January 1970 and make the reader walk back fifty-six
		// years to reach a date they can use.
		//
		// Separates "an unbounded start is treated as absent" from "it is treated as a date the
		// reader picked". Both render a calendar, so only the caption tells them apart.
		expect(
			reopeningMonthAnchor({
				from: PERIOD_EPOCH_FLOOR,
				to: '2026-06-12',
				lastEdited: null,
				todayIso
			})
		).toBe('2026-06-12');
	});

	it('falls back to today when the range is nothing but an epoch floor', () => {
		// Separates "the floor is skipped and the normal fallback chain continues" from "the floor
		// is skipped straight to the end, which is not there either".
		expect(
			reopeningMonthAnchor({ from: PERIOD_EPOCH_FLOOR, to: '', lastEdited: null, todayIso })
		).toBe(todayIso);
	});

	it('opens on the end month when the end was the last thing written', () => {
		// 6E's single exception: reopening on the start would make the reader redo the path they
		// just walked.
		expect(
			reopeningMonthAnchor({ from: '2026-03-03', to: '2026-06-12', lastEdited: 'to', todayIso })
		).toBe('2026-06-12');
	});

	it('ignores the exception when there is no end to open on', () => {
		expect(reopeningMonthAnchor({ from: '2026-03-03', to: null, lastEdited: 'to', todayIso })).toBe(
			'2026-03-03'
		);
	});

	it('falls back to today when no range exists', () => {
		expect(reopeningMonthAnchor({ from: null, to: null, lastEdited: null, todayIso })).toBe(
			todayIso
		);
	});
});
