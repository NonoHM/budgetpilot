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
 */
export type PeriodPresetId =
	'thisMonth' | 'lastMonth' | 'last3Months' | 'last12Months' | 'thisYear';

export const PERIOD_PRESET_IDS: readonly PeriodPresetId[] = [
	'thisMonth',
	'lastMonth',
	'last3Months',
	'last12Months',
	'thisYear'
];

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
		case 'last3Months':
			return { from: iso(year, month - 2, 1), to: todayIso };
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
 */
export function matchPeriodPreset(range: PeriodRange, todayIso: string): PeriodPresetId | null {
	if (!range.from || !range.to) return null;
	for (const id of PERIOD_PRESET_IDS) {
		const candidate = periodPresetRange(id, todayIso);
		if (candidate.from === range.from && candidate.to === range.to) return id;
	}
	return null;
}
