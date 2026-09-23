import { describe, expect, it } from 'vitest';
import {
	buildCsvFields,
	hasStrandedControlCharacter,
	refusalCellValue,
	sanitizeImportedText
} from './safety';

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
		// is tested », which is what shipped. U+0000 was the instance #594 was filed for; #652
		// changed what happens to it (see `hasStrandedControlCharacter` in safety.ts): the NUL is
		// now stripped before the guard ever runs, so the leading `=` it used to hide is read
		// directly and the stored value comes back without it, still guarded. The other two are
		// `Cf`, not `Cc`, out of scope for the strip, and still carried through unchanged.
		expect(sanitizeImportedText('\u0000=cmd')).toBe("'=cmd");
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

/**
 * #652: the class this strips is "control character", not "U+0000" — the one instance Task 1
 * measured throwing `SQLSTATE 22021` on PostgreSQL. Swept as a class rather than a single code
 * point for the same reason `formulaGuard.ts` swept `Cc`/`Cf`/`Zs`/`Zl`/`Zp` instead of enumerating
 * one character: a fix shaped as "add U+0000 to the list" is one of many.
 */
describe('sanitizeImportedText strips stranded control characters', () => {
	it('removes a control character from the middle of a value, closing the gap left behind', () => {
		expect.assertions(4);

		// U+0000, measured. U+0007 (BEL), U+001B (ESC) and U+007F (DEL): untested by the live
		// measurement but the same Unicode category, included so the fix is provably about the
		// class and not a second special case for the one byte that got measured.
		expect(sanitizeImportedText('SUPERETTE\u00003')).toBe('SUPERETTE3');
		expect(sanitizeImportedText('SUPERETTE\u00073')).toBe('SUPERETTE3');
		expect(sanitizeImportedText('SUPERETTE\u001B3')).toBe('SUPERETTE3');
		expect(sanitizeImportedText('SUPERETTE\u007F3')).toBe('SUPERETTE3');
	});

	it('strips a C1 control (U+0080-U+009F), the other half of the Cc category', () => {
		expect.assertions(1);
		expect(sanitizeImportedText('SUPERETTE\u00853')).toBe('SUPERETTE3');
	});

	it('collapses the double space a stripped-out control character leaves behind', () => {
		expect.assertions(1);
		// The control character sat between two real spaces; removing it must not leave both.
		expect(sanitizeImportedText('SUPERETTE \u0000 3')).toBe('SUPERETTE 3');
	});

	it('leaves the five whitespace-shaped Cc characters to the existing collapse, unstripped', () => {
		expect.assertions(4);
		// \t \n \v \f already become an ordinary space via the `\s+` collapse; stripping them here
		// too would concatenate words a real tab or newline separates, a regression the control-
		// character strip must not cause.
		expect(sanitizeImportedText('Foo\tBar')).toBe('Foo Bar');
		expect(sanitizeImportedText('Foo\nBar')).toBe('Foo Bar');
		expect(sanitizeImportedText('Foo\vBar')).toBe('Foo Bar');
		expect(sanitizeImportedText('Foo\fBar')).toBe('Foo Bar');
	});
});

describe('hasStrandedControlCharacter', () => {
	it('is true for the class sanitizeImportedText strips, and false once stripped', () => {
		expect.assertions(3);
		expect(hasStrandedControlCharacter('SUPERETTE\u00003')).toBe(true);
		expect(hasStrandedControlCharacter('SUPERETTE\u007F3')).toBe(true);
		expect(hasStrandedControlCharacter(sanitizeImportedText('SUPERETTE\u00003'))).toBe(false);
	});

	it('is false for ordinary text and for the whitespace-shaped Cc characters', () => {
		expect.assertions(5);
		expect(hasStrandedControlCharacter('Courses')).toBe(false);
		expect(hasStrandedControlCharacter('')).toBe(false);
		expect(hasStrandedControlCharacter('Foo\tBar')).toBe(false);
		expect(hasStrandedControlCharacter('Foo\nBar')).toBe(false);
		expect(hasStrandedControlCharacter('Foo\rBar')).toBe(false);
	});

	it('is false for a Cf character, a different Unicode category from Cc', () => {
		expect.assertions(1);
		// Zero-width space: guarded against by formulaGuard's own ignorable-leading logic, and
		// deliberately out of scope for this predicate, which is about Cc alone.
		expect(hasStrandedControlCharacter('​=cmd')).toBe(false);
	});
});

/**
 * `buildCsvFields` used to decide which field names skip `sanitizeImportedText` from a FIXED,
 * case-sensitive list of six literal spellings, no matter what the caller passed as `fields`. That
 * list was never reachable by a name it did not already know: #466's exact finding, and the
 * reason `exemptFields` is now supplied by the caller instead of guessed from the field's own
 * spelling. `resolvedRows.ts` passes whatever its OWN resolved amount column is actually called,
 * so this must work for a name the fixed list never anticipated, not only for the ones it did.
 */
describe('buildCsvFields', () => {
	it('sanitises a field outside the exempt set, neutralising a leading formula character', () => {
		expect.assertions(1);

		const result = buildCsvFields({ Libelle: '=cmd|/c calc' }, ['Libelle'], new Set());

		expect(result['Libelle']).toBe(sanitizeImportedText('=cmd|/c calc'));
	});

	it('leaves an exempt field alone, preserving a leading minus a negative amount needs', () => {
		expect.assertions(2);

		const result = buildCsvFields({ montant: '-42,00' }, ['montant'], new Set(['montant']));

		expect(result['montant']).toBe('-42,00');
		// The companion figure: sanitising the SAME value is what the exemption exists to avoid.
		expect(sanitizeImportedText('-42,00')).not.toBe('-42,00');
	});

	// THE FIX ITSELF: a lowercase, unanticipated spelling. The old fixed list carried `Montant`
	// capitalised and never `montant`, which is the ordinary French header this repository's own
	// mapping fixtures use. A caller-supplied set has no such gap, because it is never guessing a
	// spelling in the first place.
	it('exempts an arbitrary caller-supplied name, not only a name a fixed list anticipated', () => {
		expect.assertions(1);

		const result = buildCsvFields({ montant: '-8,40' }, ['montant'], new Set(['montant']));

		expect(result['montant']).toBe('-8,40');
	});

	it('exempts only the fields the caller named, not every field in the same call', () => {
		expect.assertions(2);

		const result = buildCsvFields(
			{ montant: '-8,40', libelle: '=cmd|/c calc' },
			['montant', 'libelle'],
			new Set(['montant'])
		);

		expect(result['montant']).toBe('-8,40');
		expect(result['libelle']).toBe(sanitizeImportedText('=cmd|/c calc'));
	});

	it('defaults to exempting nothing when the caller passes no exempt set', () => {
		expect.assertions(1);

		const result = buildCsvFields({ montant: '-8,40' }, ['montant']);

		expect(result['montant']).toBe(sanitizeImportedText('-8,40'));
	});
});
