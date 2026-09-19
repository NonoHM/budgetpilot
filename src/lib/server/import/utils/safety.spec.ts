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

/**
 * #594, the DEFENCE IN DEPTH half. The control point is the export writer, not here.
 *
 * `sanitizeImportedText` is one of three writers that reach a stored label, and the only one that
 * sanitises: `backup/import.ts` writes `label: transaction.label` straight from restore JSON, and
 * ASVS v5.0.0-1.2.10 says « when exporting » rather than when importing. So these assertions are
 * worth having and are NOT what makes the application safe; `exportCsv.spec.ts` is.
 *
 * Both halves are asserted together on purpose. A run where the neutralised controls silently
 * stopped being neutralised would otherwise read as a pass.
 */
describe('sanitizeImportedText and the leading character a consumer keeps', () => {
	it('neutralises a formula hidden behind a character trim does not remove', () => {
		expect.assertions(3);

		// Separates « the first character a consumer keeps is tested » from « the first code unit
		// is tested », which is what shipped. U+0000 is the instance #594 was filed for; the other
		// two are the same defect with no control byte in sight.
		expect(sanitizeImportedText('\u0000=cmd')).toBe("'\u0000=cmd");
		expect(sanitizeImportedText('\u200B=cmd')).toBe("'\u200B=cmd");
		expect(sanitizeImportedText('\u202E=cmd')).toBe("'\u202E=cmd");
	});

	it('goes on neutralising what it always did, and goes on leaving alone what it always left', () => {
		expect.assertions(6);

		// The planted controls. Clause one of the guard is preserved verbatim, and these say so:
		// if the repair had replaced the old test rather than adding to it, these would redden
		// and the three above would still pass.
		expect(sanitizeImportedText('=IMPORTXML("https://example.test")')).toBe(
			'\'=IMPORTXML("https://example.test")'
		);
		expect(sanitizeImportedText('+150,00')).toBe("'+150,00");
		expect(sanitizeImportedText('-30,00')).toBe("'-30,00");
		expect(sanitizeImportedText('@cmd')).toBe("'@cmd");
		expect(sanitizeImportedText('Courses')).toBe('Courses');
		expect(sanitizeImportedText('CARREFOUR  MARKET')).toBe('CARREFOUR MARKET');
	});

	it('is unchanged for a leading tab or carriage return, which trim removes before the test', () => {
		expect.assertions(2);

		// Named rather than left implicit, because the same two characters are LIVE in the export
		// copy of this rule and dead here. That asymmetry is why the class kept them.
		expect(sanitizeImportedText('\t=cmd')).toBe("'=cmd");
		expect(sanitizeImportedText('\r=cmd')).toBe("'=cmd");
	});
});
