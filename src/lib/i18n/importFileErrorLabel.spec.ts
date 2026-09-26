import { describe, expect, it } from 'vitest';
import { importFileErrorLabel } from './importFileErrorLabel';
import { IMPORT_FILE_ERROR_CODES, ImportFileError } from '$lib/server/import/file';

/**
 * One sentence per `ImportFileError` code, for both import routes. `/import/columns` used to say
 * « Le fichier de relevé est vide. » for EVERY code, so a workbook it could not read was reported
 * as empty (#595). The server project pins the locale to French.
 */
describe('importFileErrorLabel', () => {
	it('says an unreadable workbook is unreadable, and how to get a readable one', () => {
		expect(importFileErrorLabel(new ImportFileError('x', 'unreadable_workbook'))).toBe(
			"Ce fichier .xlsx n'est pas un classeur lisible. Exportez-le de nouveau, ou en CSV."
		);
	});

	it('keeps the sentences /import already showed for the other codes', () => {
		expect(importFileErrorLabel(new ImportFileError('x', 'bad_extension'))).toBe(
			'Le fichier doit utiliser l’extension .csv ou .xlsx.'
		);
		expect(importFileErrorLabel(new ImportFileError('x', 'empty'))).toBe(
			'Le fichier de relevé est vide.'
		);
	});

	it('renders every code from the list the type is built from', () => {
		// Enumerated from the registry, not retyped, so a code added to `file.ts` is covered here
		// the moment it exists. CALIBRATION: the list is not empty.
		expect(IMPORT_FILE_ERROR_CODES.length).toBeGreaterThan(0);
		for (const code of IMPORT_FILE_ERROR_CODES) {
			const sentence = importFileErrorLabel(
				new ImportFileError('x', code, { size: 3_000_000, max: 1_000_000 })
			);
			expect(sentence, code).toMatch(/\S/);
			expect(sentence, code).not.toContain('import_error');
		}
	});
});
