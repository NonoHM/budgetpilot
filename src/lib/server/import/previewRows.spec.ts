import { describe, expect, it } from 'vitest';
import { importPreviewRows, importSampleValues } from './csv';
import { parseRows } from './utils/csv';

/**
 * The rows the desktop preview table draws, and why they cannot be the samples.
 *
 * `importSampleValues` picks per COLUMN, because a sparse column has to show its own values
 * rather than three blanks — that is the whole of #342's fix. The consequence is that
 * `samples[0][0]` and `samples[1][0]` come from different rows whenever a column is sparse, so a
 * grid built from them invents a transaction the file does not contain.
 *
 * The plate's reason for the preview is that it shows the FILE. Reordered or fabricated, it
 * becomes a second source of truth contradicting the same file opened in a spreadsheet, and the
 * table stops being evidence.
 */

/** Column 2 is sparse on purpose: it is what makes the two functions disagree. */
const SPARSE = [
	'date,libelle,credit,montant',
	'2026-06-01,Mercerie Lafayette,,-45.20',
	'2026-06-02,Pharmacie du Pont,,-18.90',
	'2026-06-03,Salaire,2450.00,',
	'2026-06-07,Fleuriste Bellevue,,-31.00'
].join('\n');

describe('importPreviewRows', () => {
	it('returns real consecutive rows, in the file order', () => {
		expect.assertions(2);

		const rows = importPreviewRows(parseRows(SPARSE), 5);

		expect(rows).toHaveLength(4);
		expect(rows[0]).toEqual(['2026-06-01', 'Mercerie Lafayette', '', '-45.20']);
	});

	/**
	 * The assertion this file exists for.
	 *
	 * The sampler pulls `2450.00` up to be the sparse column's FIRST sample, because it is the
	 * only value there. Read as a row it would sit beside `2026-06-01` and `Mercerie Lafayette` —
	 * a credit of 2 450 € against a purchase of 45,20 €, on a line the statement does not have.
	 */
	it('does not agree with the samples, which is why the table cannot use them', () => {
		expect.assertions(2);

		const samples = importSampleValues(parseRows(SPARSE), 3);
		const preview = importPreviewRows(parseRows(SPARSE), 3);

		// The sampler lifted the only value in the sparse column to the top.
		expect(samples[2][0]).toBe('2450.00');
		// The real first row has that cell EMPTY. Building a grid from the samples would print
		// 2450.00 on the Mercerie Lafayette line.
		expect(preview[0][2]).toBe('');
	});

	it('pads a short row so its values stay under their own columns', () => {
		expect.assertions(2);

		const rows = importPreviewRows(parseRows('a,b,c\n1,2\n'), 5);

		expect(rows[0]).toHaveLength(3);
		expect(rows[0]).toEqual(['1', '2', '']);
	});

	it('stops at the count, and returns nothing for a file with no data', () => {
		expect.assertions(2);

		expect(importPreviewRows(parseRows(SPARSE), 2)).toHaveLength(2);
		expect(importPreviewRows(parseRows('date,libelle\n'), 5)).toEqual([]);
	});
});
