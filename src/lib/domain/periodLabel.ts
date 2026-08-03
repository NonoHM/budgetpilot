import { formatMonthLabel } from './dateFormat';

/**
 * The Période trigger's value slot, and the ladder that keeps it honest.
 *
 * Période is the only dimension of the filter bar whose value is COMPOSITE, and that is why it is
 * exempt from the bar's ellipsis convention. "3 mars 2026 → 12 ju…" is not a shortened value, it is
 * a DIFFERENT period, and nothing on screen tells the reader which one is real. An atomic value
 * cannot lie by being cut; a range can. So instead of truncating, this steps DOWN a ladder of
 * formats.
 *
 * THE RULE, and it is a CORRECTION of how the design deliverable phrases it:
 *
 *     Render the SHORTEST form that remains TRUE. Descend further only if that still exceeds
 *     PERIOD_VALUE_MAX_PX.
 *
 * The design's section 5a justifies the first step by width instead — it shows
 * "3 mars 2026 → 12 juin 2026" at "238 px, refusé" and drops to "3 mars → 12 juin" at "154 px,
 * retenu". Those figures come from the mockup's own, larger type scale. MEASURED in this app, in a
 * real browser, inside a real trigger's value span at 14px: that same string is **175.5px**, which
 * FITS under the 190px cap. If width were really the trigger, rung 1 would always be retained and
 * rungs 2 onward would never fire — which is plainly not what section 5b draws.
 *
 * So the design drew the outcome it wanted and justified it afterwards by a width that does not
 * hold at the real type size. The outcome is the intent; the mechanism is restated here rather
 * than patched. A future session re-measuring and finding 175.5px must NOT conclude the ladder is
 * broken.
 *
 * The 190px cap remains a real constraint — it is simply no longer what moves rung 1 to rung 2. It
 * is what moves a long-month range down to the numeric rung, and it is why the numeric rung exists
 * at all.
 */
export const PERIOD_VALUE_MAX_PX = 190;

export type PeriodRung =
	| 'preset'
	| 'long'
	| 'longNoYear'
	| 'numeric'
	| 'yearsOnly'
	| 'custom'
	| 'openStart'
	| 'openEnd'
	| 'invalid';

export interface PeriodLabel {
	/** What the trigger renders. */
	text: string;
	/** The full unabridged form. `aria-label` carries this whatever `text` says. */
	full: string;
	rung: PeriodRung;
	/** True when a Tooltip and the dotted underline are required. */
	shortened: boolean;
}

export interface PeriodCopy {
	openStart: (formattedDate: string) => string;
	openEnd: (formattedDate: string) => string;
	custom: string;
	invalid: string;
}

/**
 * Per-character advance widths for the trigger's value slot, MEASURED (not estimated, not tuned by
 * eye) in Chromium at a 1280px viewport, inside the real trigger's value span: `text-sm` (14px), the
 * app's font stack, `font-variant-numeric: tabular-nums`, `white-space: pre`. Each entry is the
 * glyph's own advance width as rendered in that exact context, to the thousandth of a pixel, read
 * off a probe span cloned from a live trigger (see the plan's Task 2 measurement script).
 *
 * `'/'` is deliberately entered at the DIGIT width (7.869) rather than its isolated advance
 * (4.322): beside digits under `tabular-nums` the solidus renders wider than it measures alone, and
 * the isolated figure under-counted `03/03/26 → 12/06/26` by 5.8px against the measured string.
 * Over-estimating is the safe direction here, so the wider figure is the one kept.
 *
 * Any character NOT in this table falls back to 14px in `estimateValueWidthPx` below — the widest
 * glyph actually measured (`W` / `→`) — so an unforeseen character over-estimates rather than
 * under-estimates.
 *
 * RE-MEASURE, do not retune by eye, if the trigger's font, font-size or letter-spacing ever changes.
 * The whole safety argument for this estimator is that it over-estimates: the design forbids the
 * ellipsis that would otherwise enforce the 190px cap in CSS, so an under-estimate overflows the
 * cap silently and reintroduces exactly the lie the shortening ladder exists to prevent. An
 * over-estimate only costs one rung dropped early, which is merely less pretty.
 */
const CHAR_PX_MEASURED: Record<string, number> = {
	' ': 3.473,
	"'": 1.753,
	'-': 3.87,
	'.': 3.691,
	'/': 7.869,
	'0': 7.869,
	'1': 7.869,
	'2': 7.869,
	'3': 7.869,
	'4': 7.869,
	'5': 7.869,
	'6': 7.869,
	'7': 7.869,
	'8': 7.869,
	'9': 7.869,
	A: 9.133,
	B: 8.723,
	C: 9.113,
	D: 9.188,
	E: 7.957,
	F: 7.738,
	G: 9.537,
	H: 9.988,
	I: 3.808,
	J: 7.725,
	K: 8.784,
	L: 7.541,
	M: 12.223,
	N: 9.988,
	O: 9.632,
	P: 8.832,
	Q: 9.632,
	R: 8.627,
	S: 8.313,
	T: 8.458,
	U: 9.078,
	V: 8.914,
	W: 12.421,
	X: 8.777,
	Y: 8.526,
	Z: 8.388,
	a: 7.616,
	b: 7.862,
	c: 7.328,
	d: 7.896,
	e: 7.424,
	f: 4.867,
	g: 7.862,
	h: 7.711,
	i: 3.405,
	j: 3.35,
	k: 7.096,
	l: 3.405,
	m: 12.277,
	n: 7.732,
	o: 7.984,
	p: 7.862,
	q: 7.957,
	r: 4.745,
	s: 7.226,
	t: 4.58,
	u: 7.718,
	v: 6.781,
	w: 10.521,
	x: 6.945,
	y: 6.624,
	z: 6.945,
	à: 7.616,
	ç: 7.328,
	è: 7.424,
	é: 7.424,
	ê: 7.424,
	ï: 3.466,
	ô: 7.984,
	û: 7.718,
	'→': 14
};

/** Fallback for any character absent from {@link CHAR_PX_MEASURED}: the widest glyph measured. */
const FALLBACK_CHAR_PX = 14;

export function estimateValueWidthPx(text: string): number {
	let total = 0;
	for (const char of text) {
		total += CHAR_PX_MEASURED[char] ?? FALLBACK_CHAR_PX;
	}
	return total;
}

/**
 * THE YEAR-DROP RULE, named so it can be cited and tested on its own.
 *
 * The year is dropped ONLY when both endpoints share it. On a cross-year range it stays, always,
 * whatever the width budget says — because "24/12/2025 → 03/01/2026" shortened to "24/12 → 03/01"
 * reads as ten days inside one year, which is precisely the falsehood the ladder exists to prevent.
 * Shortening that reintroduces the lie is not shortening, it is corruption. This is a hard gate on
 * the `longNoYear` rung, not a consequence of the formatting: if it is ever removed, the ladder
 * silently starts producing false periods and every other test still passes.
 */
export function bothDatesShareYear(from: string, to: string): boolean {
	if (!from || !to) return false;
	return from.slice(0, 4) === to.slice(0, 4);
}

function atUtcMidnight(iso: string): Date {
	return new Date(`${iso}T00:00:00.000Z`);
}

function longDate(iso: string, locale: string, withYear: boolean): string {
	return atUtcMidnight(iso).toLocaleDateString(locale, {
		day: 'numeric',
		month: 'long',
		year: withYear ? 'numeric' : undefined,
		timeZone: 'UTC'
	});
}

function numericDate(iso: string, locale: string): string {
	return atUtcMidnight(iso).toLocaleDateString(locale, {
		day: '2-digit',
		month: '2-digit',
		year: '2-digit',
		timeZone: 'UTC'
	});
}

function isFirstOfMonth(iso: string): boolean {
	return iso.slice(8, 10) === '01';
}

function isLastOfMonth(iso: string): boolean {
	const date = atUtcMidnight(iso);
	const next = new Date(date.getTime() + 86_400_000);
	return next.getUTCMonth() !== date.getUTCMonth();
}

function fits(text: string): boolean {
	return estimateValueWidthPx(text) <= PERIOD_VALUE_MAX_PX;
}

export function formatPeriodLabel(input: {
	from: string;
	to: string;
	invalid: boolean;
	locale: string;
	allowCustomRung: boolean;
	copy: PeriodCopy;
}): PeriodLabel {
	const { from, to, invalid, locale, allowCustomRung, copy } = input;

	if (invalid) {
		return { text: copy.invalid, full: copy.invalid, rung: 'invalid', shortened: false };
	}

	// One open end: the design requires the WORD, never a one-sided arrow. An arrow missing one of
	// its two ends reads as a truncated range, which is the same lie by a different route.
	if (from && !to) {
		const full = copy.openStart(longDate(from, locale, true));
		const short = copy.openStart(longDate(from, locale, false));
		const text = fits(full) ? full : short;
		return { text, full, rung: 'openStart', shortened: text !== full };
	}
	if (!from && to) {
		const full = copy.openEnd(longDate(to, locale, true));
		const short = copy.openEnd(longDate(to, locale, false));
		const text = fits(full) ? full : short;
		return { text, full, rung: 'openEnd', shortened: text !== full };
	}
	if (!from && !to) {
		return { text: '', full: '', rung: 'preset', shortened: false };
	}

	const full = `${longDate(from, locale, true)} → ${longDate(to, locale, true)}`;

	// A whole calendar month is a preset, not a range: it is what the user picked and what they
	// should read back. Checked before the ladder, because "juin 2026" is shorter AND truer than
	// any rung of "1 juin → 30 juin".
	if (
		bothDatesShareYear(from, to) &&
		from.slice(5, 7) === to.slice(5, 7) &&
		isFirstOfMonth(from) &&
		isLastOfMonth(to)
	) {
		const text = formatMonthLabel(from.slice(0, 7), locale);
		return { text, full, rung: 'preset', shortened: text !== full };
	}

	/**
	 * The candidate list IS the rule: entry 0 is the shortest form that is still true for THIS
	 * range's shape, and everything after it is the width descent.
	 *
	 * Which head the list gets is a question about TRUTH, never about pixels:
	 *  - a whole-year multi-year span is most honestly said as "2024 → 2026";
	 *  - a same-year range may drop the year, because both endpoints carry it;
	 *  - a cross-year range may NOT, so its shortest true form is the long one WITH both years.
	 *
	 * Ordering `numeric` after the head rather than before it is what keeps the numeric rung a
	 * DESCENT rung. It is a fixed width — "dd/mm/yy → dd/mm/yy" is always 20 tabular characters,
	 * ~146.85px — so it always fits, and putting it first would make it the permanent answer and
	 * every human-readable rung dead code.
	 */
	const numeric = {
		rung: 'numeric' as const,
		text: `${numericDate(from, locale)} → ${numericDate(to, locale)}`
	};

	// Whole calendar years only. "2024 → 2026" for a span that starts mid-March would be a claim
	// about January that the filter does not make.
	// `slice(5)`, not `slice(4)`: on "2024-01-01" index 4 is the hyphen, so the month-day tail is
	// "01-01". Written as `'-01-01'` this condition is false for EVERY input and the rung silently
	// never fires — which is how it was first shipped, and why the multi-year test below asserts the
	// rung by name rather than merely asserting "some rung was chosen".
	const isWholeYearSpan =
		!bothDatesShareYear(from, to) && from.slice(5) === '01-01' && to.slice(5) === '12-31';

	let head: { rung: PeriodRung; text: string };
	if (isWholeYearSpan) {
		head = { rung: 'yearsOnly', text: `${from.slice(0, 4)} → ${to.slice(0, 4)}` };
	} else if (bothDatesShareYear(from, to)) {
		// THE YEAR-DROP RUNG, gated on the named rule and on nothing else. Not on width: a same-year
		// range drops its redundant year whether or not the long form would have fitted.
		head = {
			rung: 'longNoYear',
			text: `${longDate(from, locale, false)} → ${longDate(to, locale, false)}`
		};
	} else {
		// Cross-year. The year stays on BOTH sides, regardless of available space — "24/12/2025 →
		// 03/01/2026" rendered as "24 décembre → 3 janvier" reads as ten days inside one year.
		head = { rung: 'long', text: full };
	}

	const candidates: Array<{ rung: PeriodRung; text: string }> = [head, numeric];

	for (const candidate of candidates) {
		if (fits(candidate.text)) {
			return {
				text: candidate.text,
				full,
				rung: candidate.rung,
				shortened: candidate.text !== full
			};
		}
	}

	// Last resort, desktop only: touch has no hover, so a Tooltip is not recoverable and a value
	// that names no dates at all would be unreadable at 390. The mobile ladder therefore stops at
	// the numeric rung, which is still a real range.
	//
	// Unreachable under today's measurements, and deliberately kept: `numeric` is fixed-width and
	// always fits, so nothing ever falls past it. It is the design's fifth rung and it becomes
	// reachable again the moment the numeric format, the font or the cap changes. A test asserts it
	// is what a caller gets when the numeric rung is forced not to fit, so it is covered rather
	// than merely present.
	if (allowCustomRung) {
		return { text: copy.custom, full, rung: 'custom', shortened: true };
	}
	return { text: numeric.text, full, rung: 'numeric', shortened: numeric.text !== full };
}
