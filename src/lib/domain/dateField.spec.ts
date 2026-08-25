import { describe, expect, it } from 'vitest';
import { isoToDisplay, displayToIso, toIsoOrNull } from './dateField';

/**
 * The app's own date-entry grammar, jj/mm/aaaa, as three pure functions.
 *
 * They existed as private functions inside `ui/PeriodFilter.svelte` and were reachable only by
 * driving that panel. Moved here rather than copied: a second copy is the "test and thing under
 * test must not share a source" failure one level up, where the two copies drift and each one's
 * tests keep passing. `PeriodFilter` now imports these, so there is one grammar.
 *
 * They take no locale, read no clock and touch no `$lib`, which is what lets this file assert them
 * directly and what lets the same functions run inside a form that submits an ISO value.
 */
describe('isoToDisplay', () => {
	it('writes an ISO date in the app’s own jj/mm/aaaa order', () => {
		expect(isoToDisplay('2026-08-01')).toBe('01/08/2026');
	});

	/**
	 * Separates "an empty field shows nothing" from "an empty field shows a placeholder-looking
	 * string". A `//` in the box would read as a half-typed date the reader has to clear.
	 */
	it('leaves an empty value empty', () => {
		expect(isoToDisplay('')).toBe('');
	});

	/**
	 * Separates "the function reformats what it recognises" from "it reformats everything". A value
	 * that is not an ISO date is handed back untouched, so a half-typed field is never rewritten
	 * under the reader's cursor.
	 */
	it('hands back anything that is not an ISO date untouched', () => {
		expect(isoToDisplay('01/08/2026')).toBe('01/08/2026');
		expect(isoToDisplay('nonsense')).toBe('nonsense');
	});
});

describe('displayToIso', () => {
	it('reads jj/mm/aaaa back into ISO, padding a single-digit day or month', () => {
		expect(displayToIso('01/08/2026')).toBe('2026-08-01');
		expect(displayToIso('1/8/2026')).toBe('2026-08-01');
	});

	it('hands back anything it does not recognise, trimmed', () => {
		expect(displayToIso('  nonsense  ')).toBe('nonsense');
	});
});

describe('toIsoOrNull', () => {
	it('accepts a complete, real date', () => {
		expect(toIsoOrNull('29/02/2028')).toBe('2028-02-29');
	});

	/**
	 * The strict half, and the reason it is strict rather than shape-only. Separates "the field
	 * refuses a date that does not exist" from "the field accepts the shape and lets the server
	 * refuse it". The second sends the value, gets a 400, and shows the reader an invalid state for
	 * input the field accepted without a word. Both values below match `dd/mm/yyyy` exactly and
	 * neither is a day.
	 */
	it('refuses a well-shaped date that is not a real one', () => {
		expect(toIsoOrNull('31/02/2026')).toBeNull();
		expect(toIsoOrNull('99/99/2026')).toBeNull();
	});

	it('refuses an incomplete buffer', () => {
		expect(toIsoOrNull('01/08')).toBeNull();
		expect(toIsoOrNull('')).toBeNull();
	});

	/**
	 * The round trip is the property the stored form depends on: whatever the field submits must
	 * read back as the same day. Asserted by CALLING both functions rather than by restating the
	 * format, so it cannot drift by exactly the clause a retyped oracle forgets.
	 */
	it('round-trips every accepted value through the display form', () => {
		for (const iso of ['2026-01-01', '2026-08-25', '2028-02-29', '1999-12-31']) {
			expect(toIsoOrNull(isoToDisplay(iso))).toBe(iso);
		}
	});
});
