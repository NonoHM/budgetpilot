/**
 * The app's own date-entry grammar: jj/mm/aaaa on screen, ISO in the value that travels.
 *
 * ## Why this exists at all, rather than `type="date"`
 *
 * A native date input renders jj/mm/aaaa or mm/dd/yyyy depending on the BROWSER's own locale and
 * ignores every `lang` attribute this app sets. The same build showed two different formats on two
 * machines. So a reader cannot tell, from the box alone, whether 01/08/2026 is the first of August
 * or the eighth of January, and neither can the person reading their screenshot.
 *
 * ## Why it is here and not inside a component
 *
 * These three functions were private to `ui/PeriodFilter.svelte` and reachable only by driving that
 * panel, which is why /reports and the dashboard kept native inputs: the fix existed but could not
 * be picked up. They are moved rather than copied, because two copies of one grammar drift and both
 * copies' tests keep passing.
 *
 * They read no clock, no locale and no `$lib`, which is what makes them assertable directly and
 * what lets the same value be rebuilt from what is stored. See AGENTS.md, "anything whose output is
 * STORED and later RECOMPUTED must be a pure function of what is stored": a range lands in a URL
 * and is parsed back on the server, so the grammar cannot depend on who is reading it.
 */

/** The display form of an ISO date, or the input untouched when it is not one. */
export function isoToDisplay(iso: string): string {
	if (!iso) return '';
	const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return iso;
	const [, year, month, day] = match;
	return `${day}/${month}/${year}`;
}

/** The ISO form of a display date, or the input trimmed when it is not one. */
export function displayToIso(display: string): string {
	const match = display.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (!match) return display.trim();
	const [, day, month, year] = match;
	return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * The strict half: a buffer that is not a complete, REAL date is not a date.
 *
 * Matching the server's own notion of validity is the point, not tidiness. A shape-only check
 * accepts 31/02/2026 and 99/99/2026, which makes the control go live, sends the value, and gets the
 * range refused server-side; the reader then sees an invalid state for input the field accepted
 * without a word. This refuses it at the point of entry instead.
 *
 * It does NOT make the client a security control. The server's check is the gate and the URL is
 * reachable without this function at all. This only stops the two from disagreeing.
 */
export function toIsoOrNull(display: string): string | null {
	const iso = displayToIso(display);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
	const parsed = new Date(`${iso}T00:00:00.000Z`);
	// `Number.isNaN` first: `toISOString()` THROWS on an invalid date rather than returning a
	// sentinel, which is exactly how the server-side twin of this function used to 500.
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString().slice(0, 10) === iso ? iso : null;
}
