/**
 * The pure half of the range calendar: accessible names, the status sentence, and the geometry
 * table. Everything here is a function of its arguments, so the parts of the design that are
 * assertions about WORDS and NUMBERS can be tested without a browser, and the component is left
 * holding only the parts that genuinely need one.
 *
 * The copy arrives as a parameter rather than through a `$lib/paraglide/messages` import, for the
 * same reason `PeriodCopy` in `periodLabel.ts` does: the calendar is deliberately SEPARABLE from the
 * Période dimension. /reports will mount the same grid with its own presets and its own sentences
 * ("Même période l'an dernier"), and a component that reaches for one dimension's message keys is
 * not separable, it is Période with a different name.
 */

/** The two sizes are not one grid scaled. See `RANGE_CALENDAR_SIZES` for what that means. */
export type RangeCalendarSize = 'mouse' | 'touch';

export interface RangeCalendarCopy {
	/** "début de la plage" — appended to a bound's accessible name. */
	rangeStart: string;
	/** "fin de la plage" */
	rangeEnd: string;
	/** ({ date }) => "Début au 3 juin 2026. Choisissez la fin." */
	awaitingEnd: (args: { date: string }) => string;
	/** ({ from, to, days }) => "Du 3 juin 2026 au 18 juin 2026, 16 jours." */
	rangeSelected: (args: { from: string; to: string; days: number }) => string;
	/** Said when nothing is placed yet. */
	empty: string;
}

/**
 * The geometry, as a table rather than as scattered literals, because the design's central claim
 * about this component is a claim about WHICH numbers move between the two sizes and which do not.
 * Written as one object so that claim is assertable in a single test instead of being distributed
 * across a stylesheet where nothing can see it whole.
 *
 * The rule (design 6K): what is a TARGET grows, what is a STROKE stays, what is READ grows a little.
 * Multiplying a 1px dash by 1.6 turns it into a border; multiplying a 2px ring turns it into a
 * frame. So `cell`, `radius` and `digit` are the only three fields that differ between the rows.
 */
export const RANGE_CALENDAR_SIZES = {
	/** 30px satisfies WCAG 2.5.8's SIZE clause (>= 24 in both dimensions), which is what makes a
	 *  gapless grid legitimate: the spacing clause only governs targets UNDER 24px. At 23px the
	 *  continuous grid would fail outright, with no spacing to redeem it. */
	mouse: { cell: 30, radius: 10, digit: 12, headCell: 20, headDigit: 11 },
	/** 48px is WCAG 2.5.5, a different criterion for a different pointer. A cursor aims to 2px, a
	 *  thumb to 10. This is not the mouse grid enlarged for comfort. */
	touch: { cell: 48, radius: 14, digit: 15, headCell: 28, headDigit: 12 }
} as const satisfies Record<RangeCalendarSize, Record<string, number>>;

/**
 * The strokes, shared by both sizes BY CONSTRUCTION rather than by two literals that happen to
 * agree. A future edit that scales one of these has to delete the shared constant to do it, which
 * is the point: the design's "ce qui est un trait reste" is enforced by there being nowhere to put
 * a second value.
 */
export const RANGE_CALENDAR_STROKES = {
	/** The candidate range's dashes. Never 2px: at 48px a 2px dash reads as a border. */
	candidateDash: 1,
	/** Today's underline. Answers acuity, not target size. */
	todayUnderline: 2,
	/** The focus ring, as two bands: 2px white then 2px zinc-400. A proportional ring is a frame. */
	focusRingInner: 2,
	focusRingOuter: 2,
	/** The dotted edge marking a range that continues past the displayed month. */
	continuationDots: 2,
	/** Zero, in both sizes, so the band reads as one continuous segment and not a row of pills. */
	cellGap: 0
} as const;

/**
 * The bound radius, READ FROM THE TABLE rather than derived.
 *
 * The design justifies these two values as "un tiers de la cellule dans les deux tailles", and that
 * rationale is arithmetically wrong for the touch size: 30/3 is 10, but 48/3 is 16 and the design's
 * own conformance table says 14 (as does the 6A state list, twice). So the FIGURES are normative and
 * the sentence explaining them is not. Deriving the radius here would silently ship a 16px corner
 * against a design that specifies 14 in three places.
 *
 * The ratio is still roughly a third either way (0.333 and 0.292), which is the property the
 * sentence was reaching for — "same optical roundness" — so nothing about the intent is lost by
 * pinning the numbers. `boundRadiusRatio` exists so a future third size has the real constraint
 * available instead of the false one.
 */
export function boundRadiusFor(size: RangeCalendarSize): number {
	return RANGE_CALENDAR_SIZES[size].radius;
}

/** Kept honest by a test: both sizes sit inside a narrow band around one third. */
export function boundRadiusRatio(size: RangeCalendarSize): number {
	return RANGE_CALENDAR_SIZES[size].radius / RANGE_CALENDAR_SIZES[size].cell;
}

/**
 * Inclusive day count. Inclusive because the design requires the number to settle, without
 * ambiguity, whether BOTH bounds are inside the period — and the only way to say that without a
 * second sentence is to write a count that visibly includes them (3 June to 4 June is 2 days).
 *
 * Both arguments are midnight-UTC ISO dates, so this is exact integer arithmetic with no DST term.
 */
export function inclusiveDayCount(fromIso: string, toIso: string): number {
	const from = Date.parse(`${fromIso}T00:00:00.000Z`);
	const to = Date.parse(`${toIso}T00:00:00.000Z`);
	if (Number.isNaN(from) || Number.isNaN(to)) return 0;
	return Math.floor((to - from) / 86_400_000) + 1;
}

/**
 * The accessible name of a day cell: the FULL date, then which bound it is when it is one.
 *
 * The digit alone is not a name. A screen reader moving through the grid announces "3", "4", "5"
 * with no month, no year and no indication that two of those cells are the thing being chosen —
 * which is precisely the information the band carries visually and which `aria-selected` alone
 * does not put into words.
 */
export function dayAccessibleName(args: {
	/** Already localised and complete, e.g. "mardi 3 juin 2026". */
	longDate: string;
	bound: 'start' | 'end' | null;
	copy: RangeCalendarCopy;
}): string {
	const { longDate, bound, copy } = args;
	if (bound === 'start') return `${longDate}, ${copy.rangeStart}`;
	if (bound === 'end') return `${longDate}, ${copy.rangeEnd}`;
	return longDate;
}

/**
 * The sentence in `role="status"`. A sentence, deliberately, not a beep: the panel has to say WHERE
 * it is waiting, because between the first and the second bound there is nothing on screen that a
 * non-visual reader can use to know a bound was accepted at all.
 *
 * This is also the mechanism that carries the range for WCAG 1.4.1 at 390, where design 6L removes
 * the candidate preview entirely: with no hover there is no band to read until the second tap, so
 * for one whole interaction step this sentence IS the feedback.
 */
export function rangeStatusSentence(args: {
	from: string | null;
	to: string | null;
	/** Localised long forms of the same two dates, for the sentence itself. */
	fromLong: string | null;
	toLong: string | null;
	copy: RangeCalendarCopy;
}): string {
	const { from, to, fromLong, toLong, copy } = args;
	if (!from || !fromLong) return copy.empty;
	if (!to || !toLong) return copy.awaitingEnd({ date: fromLong });
	return copy.rangeSelected({ from: fromLong, to: toLong, days: inclusiveDayCount(from, to) });
}

/**
 * Which month the grid shows.
 *
 * Named for reopening because that is the case its EXCEPTION exists for, but callers wire it as a
 * live derivation rather than an open-time snapshot, and that is deliberate: 6E requires that
 * "saisir au clavier dans « Du » ou « Au » [...] déplace la grille", so completing a date in either
 * field must move the month there and then, not at the next open. The consequence to know is that
 * finishing a date in one field WILL pull the grid away from a month the reader had navigated to
 * with the chevrons — which follows from the fields being the single source of truth, and is not an
 * accident of the wiring.
 *
 * The start is the anchor: it is the bound the reader recognises, and the only one of the two that
 * does not move when the range is lengthened. The exception is that the panel should not make
 * someone redo their own path — if the last thing they wrote was the END, reopening on the start
 * month sends them back through the months they just crossed.
 */
export function reopeningMonthAnchor(args: {
	from: string | null;
	to: string | null;
	lastEdited: 'from' | 'to' | null;
	/** Fallback when no range exists at all. */
	todayIso: string;
}): string {
	const { from, to, lastEdited, todayIso } = args;
	if (lastEdited === 'to' && to) return to;
	if (from) return from;
	if (to) return to;
	return todayIso;
}
