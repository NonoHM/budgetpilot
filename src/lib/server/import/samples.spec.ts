import { describe, expect, it } from 'vitest';
import { importFirstDataRow, importSampleCoverage, importSampleValues } from './csv';

/**
 * The samples are the evidence the user decides against, so they are chosen to DISCRIMINATE
 * rather than taken from the top. See #339.
 */
describe('importSampleValues', () => {
	let line = 0;
	const row = (...cells: string[]) => ({ cells, line: ++line });

	it('shows a sparse column its own values rather than the blanks that happen to come first', () => {
		// The measured defect, in miniature. A Banque Populaire export splits money across Debit and
		// Credit; the first rows of a real statement are debits, so the Credit column's first three
		// cells are empty and the picker rendered it « (vide), (vide), (vide) ». A user reads that as
		// dead space and designates the other column, and every credit row is then rejected.
		const rows = [
			row('Date', 'Debit', 'Credit'),
			row('01/06/2026', '-2,71', ''),
			row('02/06/2026', '-76,22', ''),
			row('03/06/2026', '-29,61', ''),
			row('04/06/2026', '', '23,40'),
			row('05/06/2026', '', '1940,00')
		];

		const [, debit, credit] = importSampleValues(rows);

		expect(debit).toEqual(['-2,71', '-76,22', '-29,61']);
		expect(credit).toEqual(['23,40', '1940,00', '']);
	});

	it('still pads a genuinely empty column, because « (vide) » is the honest answer there', () => {
		// The padding is not the defect. A column that carries nothing must still render three lines,
		// and the card's fixed 107 px depends on it.
		const rows = [row('Date', 'Vide'), row('01/06/2026', ''), row('02/06/2026', '')];

		expect(importSampleValues(rows)[1]).toEqual(['', '', '']);
	});

	it('reads past the first rows to find values, rather than only within them', () => {
		// A column whose only values are late in the file is exactly the one a top-of-file sample
		// misrepresents, and a statement's income rows are often clustered at month end.
		const rows = [
			row('Date', 'Rare'),
			...Array.from({ length: 40 }, (_, i) => row(`${i}/06/2026`, '')),
			row('30/06/2026', '1940,00')
		];

		expect(importSampleValues(rows)[1]).toEqual(['1940,00', '', '']);
	});
});

/**
 * Three values look identical whether a column holds three or six hundred. This is what separates
 * them, and it is why the number is carried rather than inferred from the samples.
 */
describe('importSampleCoverage', () => {
	let line = 0;
	const row = (...cells: string[]) => ({ cells, line: ++line });

	it('counts the data rows that carry a value, per column', () => {
		const rows = [
			row('Date', 'Debit', 'Credit'),
			row('01/06/2026', '-2,71', ''),
			row('02/06/2026', '-76,22', ''),
			row('03/06/2026', '', '23,40')
		];

		expect(importSampleCoverage(rows)).toEqual([3, 2, 1]);
	});

	it('does not count a cell that is only whitespace', () => {
		// Same predicate as the sampler, deliberately: a column whose values the samples skip must
		// not be counted as carrying them, or the card would say « 2 valeurs » beside « (vide) ».
		const rows = [row('Date', 'Blanc'), row('01/06/2026', '   '), row('02/06/2026', '')];

		expect(importSampleCoverage(rows)).toEqual([2, 0]);
	});
});

/**
 * THE FOUR ROLE ROWS SHOW ONE TRANSACTION, READ VERTICALLY, and the handoff makes that
 * load-bearing rather than decorative (§3.2): it is the stated reason the screen carries no
 * rows-preview at 390 (ruling D2). « Do not source the examples from different rows per role —
 * it would silently destroy the only line-level verification the screen offers. »
 *
 * So this is deliberately NOT `importSampleValues`. The picker's cards are chosen to
 * discriminate; the row's example is positional; the two must not share a source. Sharing one is
 * exactly what this change nearly shipped.
 */
describe('importFirstDataRow', () => {
	let line = 0;
	const row = (...cells: string[]) => ({ cells, line: ++line });

	it('reads the first data row, even where that row is empty', () => {
		const rows = [
			row('Date', 'Debit', 'Credit'),
			row('01/06/2026', '-620,00', ''),
			row('03/06/2026', '', '1940,00')
		];

		// Credit is empty on row 1 and that is the honest answer: the row renders « (vide) » and the
		// examples still describe one transaction. Showing 1940,00 would put a Montant from row 2
		// beside a Date from row 1.
		expect(importFirstDataRow(rows)).toEqual(['01/06/2026', '-620,00', '']);
	});

	it('pads to the header width, so a short row cannot shift the columns', () => {
		const rows = [row('Date', 'Libelle', 'Montant'), row('01/06/2026', 'LOYER')];

		expect(importFirstDataRow(rows)).toEqual(['01/06/2026', 'LOYER', '']);
	});

	it('is empty for a file with no data rows', () => {
		expect(importFirstDataRow([row('Date', 'Montant')])).toEqual(['', '']);
	});
});
