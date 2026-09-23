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

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Long month heading from a `yyyy-mm` period key ("2026-07" -> "juillet 2026"). Unlike
 * `formatShortDate` this one pins `timeZone: 'UTC'`: the input has no day component, so it is
 * anchored at the 1st at UTC midnight, and a caller west of Greenwich would otherwise be shown the
 * PREVIOUS month.
 *
 * `month` is validated before it ever reaches `Date`/`Intl`: an out-of-range or malformed value
 * (`'2026-13'`, `''`) would otherwise surface as `RangeError: Invalid time value`, a message that
 * says nothing about which input caused it. A downstream caller building this from a URL query
 * string (a later task) needs a predictable, catchable failure rather than a generic engine
 * exception — so this throws its OWN `RangeError` with the offending value in the message, on
 * purpose, rather than silently falling back to a placeholder string that would hide a bad link.
 */
export function formatMonthLabel(month: string, locale: string): string {
	if (!MONTH_KEY_PATTERN.test(month)) {
		throw new RangeError(`formatMonthLabel: invalid month key "${month}", expected "yyyy-mm"`);
	}
	const date = new Date(`${month}-01T00:00:00.000Z`);
	return new Intl.DateTimeFormat(locale, {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	}).format(date);
}

/**
 * A date the user is being asked to CHECK, not merely to read.
 *
 * ## Why this is not `formatShortDate`
 *
 * Two differences, both deliberate, both about verification rather than display.
 *
 * **The year is always shown.** `formatShortDate` suppresses it in the current year, which is right
 * for a list the reader is scanning. This date exists so someone can confirm that `03/04/2026`
 * really became 3 April 2026, and a year-less date cannot be checked against a statement.
 *
 * **The zone is pinned to UTC.** `formatShortDate` deliberately pins none, matching the behaviour
 * it was extracted from. Here that would be a defect rather than a cosmetic difference: the ISO
 * value is anchored at UTC midnight, so a reader west of Greenwich would be shown the PREVIOUS day
 * and would confirm a reading against a date the import never used. The pair's whole purpose is
 * that the two halves agree with what was stored.
 *
 * Pure: no clock, unlike `formatShortDate` above, so the same ISO value renders identically for
 * every reader in a given locale and a test does not depend on the year it runs in.
 */
export function formatReadingDate(iso: string, locale: string): string {
	return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString(locale, {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	});
}
