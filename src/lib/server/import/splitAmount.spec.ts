import { describe, expect, it } from 'vitest';
import { detectComplementAmountColumn, detectSplitAmountPair } from './splitAmount';

/**
 * The shape #343 measured: a statement whose money lives in TWO columns, designated as one.
 *
 * #320's detector cannot see this one. Its first condition is "every parsable amount is >= 0",
 * on the reasoning that a signed column means the file signs its own amounts and an indicator
 * beside it is redundant. A Banque Populaire `Debit` column is already signed negative, so the
 * file passes that guard, imports, and every credit row is rejected one at a time as
 * « montant invalide »: a silent partial import under a decision the app then memorises.
 */
describe('detectComplementAmountColumn', () => {
	let line = 0;
	const row = (...cells: string[]) => ({ cells, line: ++line });

	const HEADERS = ['Date', 'Libelle', 'Debit', 'Credit'];

	it('names the sibling that carries the amounts the designated column is missing', () => {
		const rows = [
			row(...HEADERS),
			row('01/06/2026', 'LOYER', '-620,00', ''),
			row('02/06/2026', 'COURSES', '-54,12', ''),
			row('03/06/2026', 'SALAIRE', '', '1940,00'),
			row('04/06/2026', 'REMBOURSEMENT', '', '23,40')
		];

		expect(detectComplementAmountColumn(HEADERS, rows, 'Debit')).toBe('Credit');
	});

	it('names it from either side, because the user may designate either one', () => {
		const rows = [
			row(...HEADERS),
			row('01/06/2026', 'LOYER', '-620,00', ''),
			row('02/06/2026', 'SALAIRE', '', '1940,00')
		];

		expect(detectComplementAmountColumn(HEADERS, rows, 'Credit')).toBe('Debit');
	});

	it('says nothing about a file whose amount column is never empty', () => {
		// The overwhelmingly common shape. One signed amount column and a sibling that happens to
		// hold numbers, a balance or a running total, must not be read as a complement.
		const headers = ['Date', 'Libelle', 'Montant', 'Solde'];
		const rows = [
			row(...headers),
			row('01/06/2026', 'LOYER', '-620,00', '1380,00'),
			row('02/06/2026', 'SALAIRE', '1940,00', '3320,00')
		];

		expect(detectComplementAmountColumn(headers, rows, 'Montant')).toBeNull();
	});

	it('says nothing when a sibling only PARTLY covers the gaps', () => {
		// Not a debit/credit pair: the third row is empty in both, so those rows are genuinely
		// invalid and refusing the whole file would be wrong. The existing per-row refusal is the
		// right answer there, and this detector must leave it alone.
		const rows = [
			row(...HEADERS),
			row('01/06/2026', 'LOYER', '-620,00', ''),
			row('02/06/2026', 'SALAIRE', '', '1940,00'),
			row('03/06/2026', 'LIGNE VIDE', '', '')
		];

		expect(detectComplementAmountColumn(HEADERS, rows, 'Debit')).toBeNull();
	});

	it('says nothing when both columns are populated on the same row', () => {
		// Mutual exclusivity is the debit/credit signature. A row carrying both is some other
		// shape, and guessing at it is how a guard starts refusing files that would have imported.
		const rows = [
			row(...HEADERS),
			row('01/06/2026', 'LOYER', '-620,00', ''),
			row('02/06/2026', 'DOUBLE', '-10,00', '10,00'),
			row('03/06/2026', 'SALAIRE', '', '1940,00')
		];

		expect(detectComplementAmountColumn(HEADERS, rows, 'Debit')).toBeNull();
	});

	it('says nothing when the sibling holds text rather than amounts', () => {
		// A label column is empty on no rows and parses as no amount; a category column likewise.
		// Only a column that could have BEEN the amount is a complement.
		const headers = ['Date', 'Montant', 'Commentaire'];
		const rows = [
			row(...headers),
			row('01/06/2026', '-620,00', ''),
			row('02/06/2026', '', 'en attente')
		];

		expect(detectComplementAmountColumn(headers, rows, 'Montant')).toBeNull();
	});

	it('says nothing about a file with no rows to judge', () => {
		expect(detectComplementAmountColumn(HEADERS, [row(...HEADERS)], 'Debit')).toBeNull();
	});
});

/**
 * The UPLOAD-time form: no column is designated yet, and the plate says that is exactly when this
 * has to be decided. §1q table B: « La détection doit refuser le fichier AVANT cet écran et le
 * nommer sur /imports. »
 */
describe('detectSplitAmountPair', () => {
	let line = 0;
	const row = (...cells: string[]) => ({ cells, line: ++line });

	it('finds the pair before anyone has designated anything', () => {
		const headers = ['Date', 'Libelle', 'Debit', 'Credit'];
		const rows = [
			row(...headers),
			row('01/06/2026', 'LOYER', '-620,00', ''),
			row('02/06/2026', 'COURSES', '-54,12', ''),
			row('03/06/2026', 'SALAIRE', '', '1940,00')
		];

		expect(detectSplitAmountPair(headers, rows)).toEqual(['Debit', 'Credit']);
	});

	it('returns them in file order, so the sentence reads left to right like the file', () => {
		const headers = ['Date', 'Credit', 'Debit'];
		const rows = [
			row(...headers),
			row('01/06/2026', '', '-620,00'),
			row('03/06/2026', '1940,00', '')
		];

		expect(detectSplitAmountPair(headers, rows)).toEqual(['Credit', 'Debit']);
	});

	it('says nothing about an ordinary single-amount file', () => {
		const headers = ['Date', 'Libelle', 'Montant', 'Solde'];
		const rows = [
			row(...headers),
			row('01/06/2026', 'LOYER', '-620,00', '1380,00'),
			row('02/06/2026', 'SALAIRE', '1940,00', '3320,00')
		];

		expect(detectSplitAmountPair(headers, rows)).toBeNull();
	});

	it('refuses to guess when more than one pair would qualify', () => {
		// Two candidate pairings and no way to tell which is the money. Guessing here is how a
		// guard starts refusing files that would have imported: the user gets the designation
		// screen, which is the status quo and is not wrong for a shape nobody can name.
		const headers = ['A', 'B', 'C', 'D'];
		const rows = [row(...headers), row('1,00', '', '2,00', ''), row('', '3,00', '', '4,00')];

		expect(detectSplitAmountPair(headers, rows)).toBeNull();
	});

	it('says nothing when a row carries neither, since those rows are simply invalid', () => {
		const headers = ['Date', 'Debit', 'Credit'];
		const rows = [
			row(...headers),
			row('01/06/2026', '-620,00', ''),
			row('02/06/2026', '', '1940,00'),
			row('03/06/2026', '', '')
		];

		expect(detectSplitAmountPair(headers, rows)).toBeNull();
	});
});
