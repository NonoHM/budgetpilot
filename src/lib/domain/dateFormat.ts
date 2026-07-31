/**
 * Short display date ("31 juil.", or "31 juil. 2025" only when the year differs from the current
 * one — CLAUDE.md's "Dates: year shown only if != the current year" rule). `iso` is parsed at UTC
 * midnight; matches the existing behavior this was extracted from (no explicit `timeZone` on
 * `toLocaleDateString`, so rendering follows the caller's local timezone).
 */
export function formatShortDate(iso: string, locale: string): string {
	const date = new Date(`${iso}T00:00:00.000Z`);
	const includeYear = date.getUTCFullYear() !== new Date().getUTCFullYear();
	return date.toLocaleDateString(locale, {
		day: 'numeric',
		month: 'short',
		year: includeYear ? 'numeric' : undefined
	});
}

/**
 * Long month heading from a `yyyy-mm` period key ("2026-07" -> "juillet 2026"). Unlike
 * `formatShortDate` this one pins `timeZone: 'UTC'`: the input has no day component, so it is
 * anchored at the 1st at UTC midnight, and a caller west of Greenwich would otherwise be shown the
 * PREVIOUS month.
 */
export function formatMonthLabel(month: string, locale: string): string {
	const date = new Date(`${month}-01T00:00:00.000Z`);
	return new Intl.DateTimeFormat(locale, {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	}).format(date);
}
