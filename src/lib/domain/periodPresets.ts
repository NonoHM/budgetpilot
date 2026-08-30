/**
 * The Période panel's presets, and the ONLY place that turns one into a date range.
 *
 * Presets serialise into the EXISTING `from`/`to` params. There is deliberately no `period=` param:
 * three sites read this page's filter params today (the load, the bulkTag action, and the export
 * route) and they have already diverged once, causing a real bug. A fourth param would be a fourth
 * thing to keep in agreement, and a preset is fully expressible as the range it means.
 *
 * `todayIso` is a parameter, never a clock read inside this module: a preset that reads the wall
 * clock cannot be tested at a boundary, and a fixture pinned to the real clock is one of the
 * assertions CLAUDE.md records as structurally incapable of failing.
 *
 * Six presets, and six is a LAYOUT constraint rather than a taste: the design's panel height budget
 * gives the preset block 102px, which is exactly three rows of 30px plus two 6px gaps, in two
 * columns. A seventh preset adds a fourth row and moves the panel's height off the specified 552.
 *
 * `last3Months` was displaced rather than supplemented. It is not in the design's list, and the two
 * that are — `last30Days` and `thisQuarter` — arrive in a block that cannot hold seven. Nothing
 * breaks for someone whose bookmarked URL still carries the old three-month range: presets are not
 * stored, they are recovered by comparing ranges (see `matchPeriodPreset`), so that range simply
 * stops lighting a preset up and continues to filter exactly as before.
 */
export type PeriodPresetId =
	| 'thisMonth'
	| 'lastMonth'
	| 'last30Days'
	| 'last90Days'
	| 'thisQuarter'
	| 'thisYear'
	| 'last12Months'
	| 'allTime';

/**
 * The named periods a URL can carry as `?period=`.
 *
 * Declared HERE rather than in `server/date-range.ts`, which re-exports it, so that the preset
 * block and the server's parser read one list instead of two. It moved rather than being copied,
 * for the reason the money widening records: a second copy is free to agree today and diverge on
 * the next change, and nothing would go red in between.
 *
 * This module still imports nothing. A preset that reached for a clock, a locale or `$lib` could
 * not be tested at a boundary, and `todayIso` being a parameter is the same rule applied one level
 * down.
 */
export type PeriodKey =
	'this-month' | 'last-month' | 'last-30-days' | 'last-90-days' | 'all-time' | 'custom';

/**
 * SET A, /transactions. Reading order matches the design's two-column grid, filled row by row.
 *
 * The name is unchanged because this list is unchanged: the widening added a second set beside it
 * rather than editing this one, so /transactions keeps the six it shipped with.
 */
export const PERIOD_PRESET_IDS: readonly PeriodPresetId[] = [
	'thisMonth',
	'lastMonth',
	'last30Days',
	'thisQuarter',
	'thisYear',
	'last12Months'
];

/**
 * SET B, the dashboard and both /reports breakpoint chromes.
 *
 * Five rather than six, and the two that differ from set A are the two those screens have always
 * carried: `last90Days` and `allTime`. `custom` is deliberately absent — it is not a preset but
 * the state of having typed a range, which the panel's own Du/Au fields already express.
 *
 * Both sets are held to the same layout budget in the spec. 102px of preset block is three 30px
 * rows plus two 6px gaps in two columns, so six is the ceiling for ANY set, not a fact about the
 * first one written.
 */
export const REPORTING_PERIOD_PRESET_IDS: readonly PeriodPresetId[] = [
	'thisMonth',
	'lastMonth',
	'last30Days',
	'last90Days',
	'allTime'
];

/**
 * Which named `?period=` key a preset IS, or `null` when it has no spelling as one.
 *
 * This is the whole reason set B could not simply reuse set A's machinery. A preset on
 * /transactions is fully expressible as the range it means, and that module's opening comment says
 * so correctly for that screen. On the dashboard and /reports it is NOT: `server/date-range.ts`
 * derives `comparisonMonth` from the KEY and never from the range, and only for `this-month` and
 * `last-month`. So a this-month preset applied as `?period=custom&from=...&to=...` would take the
 * month-over-month comparison off both screens with nothing saying so.
 *
 * `null` rather than `'custom'` for the three /transactions-only presets: a caller must be able to
 * tell "this preset has no key" from "this preset means the custom period", because the second
 * needs `from` and `to` in the URL and the first is a caller error.
 */
export function periodKeyOfPreset(id: PeriodPresetId): PeriodKey | null {
	switch (id) {
		case 'thisMonth':
			return 'this-month';
		case 'lastMonth':
			return 'last-month';
		case 'last30Days':
			return 'last-30-days';
		case 'last90Days':
			return 'last-90-days';
		case 'allTime':
			return 'all-time';
		case 'thisQuarter':
		case 'thisYear':
		case 'last12Months':
			return null;
	}
}

/**
 * The lower bound of the all-time period. Not a date anybody chose: it is the floor `?period=all-time`
 * resolves to, and no transaction predates it.
 *
 * Exported because two other modules need to RECOGNISE it rather than merely produce it.
 * `reopeningMonthAnchor` treats a range starting here as unbounded below, so the grid opens on the
 * end instead of on January 1970.
 */
export const PERIOD_EPOCH_FLOOR = '1970-01-01';

export interface PeriodRange {
	from: string;
	to: string;
}

function iso(year: number, monthIndex: number, day: number): string {
	return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

/** Day 0 of the NEXT month is the last day of this one — no leap-year table needed. */
function lastDayOfMonth(year: number, monthIndex: number): string {
	return new Date(Date.UTC(year, monthIndex + 1, 0)).toISOString().slice(0, 10);
}

export function periodPresetRange(id: PeriodPresetId, todayIso: string): PeriodRange {
	const today = new Date(`${todayIso}T00:00:00.000Z`);
	const year = today.getUTCFullYear();
	const month = today.getUTCMonth();

	switch (id) {
		case 'thisMonth':
			return { from: iso(year, month, 1), to: lastDayOfMonth(year, month) };
		case 'lastMonth':
			return { from: iso(year, month - 1, 1), to: lastDayOfMonth(year, month - 1) };
		case 'last30Days': {
			// Inclusive of today, so "30 derniers jours" really spans 30 days and not 31. Arithmetic
			// on a midnight-UTC epoch, never on local time, so no DST boundary can shift it by one.
			const start = new Date(today.getTime() - 29 * 86_400_000);
			return { from: start.toISOString().slice(0, 10), to: todayIso };
		}
		case 'last90Days': {
			// Same rolling shape and the same off-by-one as `last30Days`: inclusive of today, so the
			// window really spans 90 days. It agrees with `?period=last-90-days`, whose exclusive
			// upper bound is tomorrow and whose lower bound is 90 days before that, and
			// `date-range.spec.ts` compares the two functions rather than either against a table.
			const start = new Date(today.getTime() - 89 * 86_400_000);
			return { from: start.toISOString().slice(0, 10), to: todayIso };
		}
		case 'allTime':
			// The epoch, because `?period=all-time` resolves to `new Date(0)` and no transaction
			// predates 1970. Written as a literal rather than derived: it is a floor, not a date
			// anybody chose, and deriving it from a clock would make it drift.
			return { from: PERIOD_EPOCH_FLOOR, to: todayIso };
		case 'thisQuarter': {
			// The WHOLE calendar quarter, like `thisMonth` and `thisYear` and unlike the two rolling
			// windows: "ce trimestre" names a period, it does not measure backwards from today.
			const firstMonthOfQuarter = Math.floor(month / 3) * 3;
			return {
				from: iso(year, firstMonthOfQuarter, 1),
				to: lastDayOfMonth(year, firstMonthOfQuarter + 2)
			};
		}
		case 'last12Months':
			return { from: iso(year, month - 11, 1), to: todayIso };
		case 'thisYear':
			return { from: iso(year, 0, 1), to: iso(year, 11, 31) };
	}
}

/**
 * Which preset, if any, the current range IS. Used to put the check on the right row when the user
 * reopens the panel — the URL carries only from/to, so the preset has to be recovered by comparing
 * ranges rather than read back from a param.
 *
 * `presets` defaults to set A so /transactions is unchanged, and a caller that mounted set B must
 * pass it: matching against the wrong set is silent, returning `null` where a row should light,
 * which reads on screen as "this range is custom" for a period the reader picked by name.
 */
export function matchPeriodPreset(
	range: PeriodRange,
	todayIso: string,
	presets: readonly PeriodPresetId[] = PERIOD_PRESET_IDS
): PeriodPresetId | null {
	if (!range.from || !range.to) return null;
	for (const id of presets) {
		const candidate = periodPresetRange(id, todayIso);
		if (candidate.from === range.from && candidate.to === range.to) return id;
	}
	return null;
}

/**
 * The `?period=` key a range should be serialised under, for the screens that carry one.
 *
 * The single place that answers "which named period is this range", so the dashboard and
 * /reports cannot drift from each other or from the row the panel lights. It is the SAME
 * `matchPeriodPreset` the panel uses for lighting, which is what keeps the URL and the highlighted
 * button unable to disagree.
 *
 * A hand-typed range that happens to equal a preset comes back under that preset's name rather
 * than as `custom`. That is deliberate: it is the same period either way, the panel already lights
 * the row for it, and the named form is the one that carries `comparisonMonth`.
 */
export function periodKeyOfRange(
	range: PeriodRange,
	todayIso: string,
	presets: readonly PeriodPresetId[] = PERIOD_PRESET_IDS
): PeriodKey {
	const preset = matchPeriodPreset(range, todayIso, presets);
	return (preset && periodKeyOfPreset(preset)) ?? 'custom';
}

/**
 * The query string a screen should navigate to after a range is applied.
 *
 * The counterpart of `server/date-range.ts`'s `serializePeriodParams`, which answers the same
 * question from a parsed `DateRange` on the server. `date-range.spec.ts` compares the two
 * functions directly for every reporting preset, because a period applied from the panel and the
 * same period linked from the page must be the same URL.
 *
 * A named period is written as its key ALONE. Adding `from` and `to` beside it would be harmless
 * to the parser and misleading to the reader, and it would make a bookmarked URL survive as a
 * frozen range rather than as the period it names.
 */
export function periodQueryOfRange(
	range: PeriodRange,
	todayIso: string,
	presets: readonly PeriodPresetId[] = PERIOD_PRESET_IDS
): string {
	const key = periodKeyOfRange(range, todayIso, presets);
	const params = new URLSearchParams({ period: key });
	if (key === 'custom') {
		params.set('from', range.from);
		params.set('to', range.to);
	}
	return params.toString();
}
