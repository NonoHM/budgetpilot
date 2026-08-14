import { describe, expect, it } from 'vitest';
import { refusalCellValue, sanitizeImportedText } from './safety';

/**
 * `refusalCellValue` exists because a refusal fact travels to the browser.
 *
 * Every other sanitised value in the import path stays on the server or is written to a column,
 * where an unbounded length is somebody else's problem. A fact is serialised into the page's
 * data on every failed import, so a cell the user controls reaches the client verbatim unless
 * something bounds it. `sanitizeImportedText` does not: it normalises and neutralises, and
 * returns whatever length it was given.
 */

const LIMIT = 64;

describe('refusalCellValue', () => {
	it('leaves a short value exactly as sanitizeImportedText would', () => {
		// The presence half. Without it, the bound assertions below would pass on a function
		// that returned the empty string for everything.
		expect(refusalCellValue('depense')).toBe('depense');
		expect(refusalCellValue('  EUR  ')).toBe('EUR');
		expect(refusalCellValue('depense')).toBe(sanitizeImportedText('depense'));
	});

	it('bounds a long value, and the input it bounds is one a CSV can really carry', () => {
		// 250000 is the order of a single cell under IMPORT_MAX_BYTES (256000). This is the
		// figure the bound exists for, not a token long string.
		const hostile = 'A'.repeat(250_000);

		const bounded = refusalCellValue(hostile);

		expect(hostile).toHaveLength(250_000);
		expect(bounded.length).toBeLessThanOrEqual(LIMIT + 3);
		expect(bounded.startsWith('A'.repeat(LIMIT))).toBe(true);
		expect(bounded.endsWith('...')).toBe(true);
	});

	it('still neutralises a formula before bounding, so truncation cannot hide the guard', () => {
		// Order matters: bounding first could cut a value down to something the dangerous
		// pattern no longer matches, and the quote would never be added.
		expect(refusalCellValue('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
		expect(refusalCellValue(`=${'9'.repeat(200)}`).startsWith("'=")).toBe(true);
	});

	it('collapses whitespace, so a cell of newlines cannot pad the payload', () => {
		expect(refusalCellValue('a\n\n\n\n\nb')).toBe('a b');
	});
});
