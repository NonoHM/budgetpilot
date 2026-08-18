import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from './csv';
import type { CsvImportResult } from './types';
import type { ColumnMappingInput } from './mapping/model';

/**
 * What the four figures on the import summary count, asserted at the writer.
 *
 * ## The defect these reproduce
 *
 * A refused import reported « 8 lignes lues, 0 importées, 0 doublons ignorés, 3 invalides », and
 * the 3 was not three rows. It was ONE row, the header, counted once per missing required role,
 * because every profile wrote `invalidRows: refusals.length` while writing `totalRows` as a count
 * of DATA rows. Two writers, two populations, one box.
 *
 * A row cannot be refused twice: every `addRefusal` in every row loop is followed immediately by
 * `return` or `continue`, verified across all of them. So the row loops always did partition their
 * rows, and the split is only ever introduced by a refusal that is ABOUT the file or the header,
 * which is not a row and has no business in a count of rows.
 *
 * ## The invariant asserted here, and where it deliberately is NOT asserted
 *
 * `totalRows === validRows + invalidRows` at the PARSER, which is where it holds by construction.
 * The screen does not restate it: the summary no longer presents the four as a row of tiles a
 * reader can subtract, so there is no user-facing sum for a test to defend. Pinning it here rather
 * than on the page is the point, not an omission.
 */

const REFUSED_HEADERS = 'Operation;Somme;Jour;Ref';

function refusedFile(dataRows: number): string {
	const rows = Array.from(
		{ length: dataRows },
		(_, index) => `Achat ${index};-12,30;01/06/2026;R${index}`
	);
	return [REFUSED_HEADERS, ...rows].join('\n');
}

/** The four figures as one tuple, so a drift in any of them reads as one diff. */
function counts(result: CsvImportResult) {
	const { totalRows, validRows, invalidRows, fileLevelRefusals, duplicateRows } = result.summary;
	return { totalRows, validRows, invalidRows, fileLevelRefusals, duplicateRows };
}

describe('a file refused for its header counts no invalid rows', () => {
	it('reports the three missing roles as file level refusals, not as three bad rows', () => {
		const result = parseCsvTransactions(refusedFile(8));

		// The measured defect: this used to read invalidRows 3, against 8 rows read, with five
		// rows unaccounted for and nothing on the screen saying so.
		expect(counts(result)).toStrictEqual({
			totalRows: 8,
			validRows: 0,
			invalidRows: 0,
			fileLevelRefusals: 3,
			duplicateRows: 0
		});
	});

	it('still names all three roles, because the count moving must not cost the reasons', () => {
		const result = parseCsvTransactions(refusedFile(8));

		expect(result.invalidRows.map((row) => row.fact)).toStrictEqual([
			{ code: 'missing-required-column', role: 'date' },
			{ code: 'missing-required-column', role: 'label' },
			{ code: 'missing-required-column', role: 'amount' }
		]);
		expect(result.invalidRows.every((row) => row.scope.kind === 'header')).toBe(true);
	});

	it('counts one complaint per duplicated header on top, all of them file level', () => {
		// date, label and amount all resolve, so the ONLY refusal is the duplicate: this separates
		// "the duplicate is counted" from "the missing roles are counted".
		const result = parseCsvTransactions(
			'date;label;amount;label\n01/06/2026;Courses;-12,30;Courses\n'
		);

		expect(counts(result)).toMatchObject({ totalRows: 1, invalidRows: 0, fileLevelRefusals: 1 });
	});
});

describe('a duplicated header is named as the FILE spells it', () => {
	it('names both spellings when the fold is what made them the same', () => {
		// `Libellé` and `libelle` are one column to us and two columns to the user, and the fold is
		// exactly why this file is refused. Naming one of them sends them to the header that is not
		// the problem; naming the folded form sends them to a string their file does not contain.
		const result = parseCsvTransactions(
			'date;Libellé;amount;libelle\n01/06/2026;Courses;-12,30;Courses\n'
		);

		expect(result.invalidRows.map((row) => row.fact)).toStrictEqual([
			{ code: 'duplicate-column', column: 'Libellé, libelle' }
		]);
	});

	it('names it once when both columns are spelled the same way', () => {
		// The ordinary case, and the reason the spellings are distinct rather than one per column:
		// « label, label » says nothing the singular does not.
		const result = parseCsvTransactions('date;label;amount;label\n01/06/2026;Courses;-12,30;x\n');

		expect(result.invalidRows.map((row) => row.fact)).toStrictEqual([
			{ code: 'duplicate-column', column: 'label' }
		]);
	});

	it('does not fold the spelling away on the mapped path either', () => {
		const result = parseCsvTransactions('Jour;Somme;SOMME\n24/06/2026;-24,90;-24,90\n', {
			profile: 'mapped',
			columnMapping: {
				matchBy: 'name',
				dateColumn: 'jour',
				labelColumn: 'somme',
				amountColumn: 'somme',
				categoryColumn: null,
				dateIndex: null,
				labelIndex: null,
				amountIndex: null,
				categoryIndex: null,
				columnCount: 3
			}
		});

		expect(result.invalidRows[0].fact).toStrictEqual({
			code: 'duplicate-column',
			column: 'Somme, SOMME'
		});
	});
});

describe('a file refused before its rows were read still says how many rows it has', () => {
	it('reports the real row count when the row cap refuses it', () => {
		// 1001 data rows against a cap of 1000. This used to report ZERO rows read for a file that
		// plainly has rows, which is worse than a triple that does not add up: nothing signals it.
		const result = parseCsvTransactions(refusedFile(1001), { maxRows: 1000 });

		expect(result.invalidRows.map((row) => row.fact)).toStrictEqual([
			{ code: 'too-many-rows', max: 1000 }
		]);
		expect(counts(result)).toStrictEqual({
			totalRows: 1001,
			validRows: 0,
			invalidRows: 0,
			fileLevelRefusals: 1,
			duplicateRows: 0
		});
	});

	it('reports the real row count when the column cap refuses it', () => {
		const wide = ['a;b;c;d', '1;2;3;4', '5;6;7;8'].join('\n');
		const result = parseCsvTransactions(wide, { maxColumns: 3 });

		expect(result.invalidRows.map((row) => row.fact)).toStrictEqual([
			{ code: 'too-many-columns', max: 3 }
		]);
		expect(counts(result)).toMatchObject({ totalRows: 2, fileLevelRefusals: 1, invalidRows: 0 });
	});

	it('reports the real row count when a named profile does not recognise the header', () => {
		const result = parseCsvTransactions(refusedFile(4), { profile: 'revolut' });

		expect(result.invalidRows.map((row) => row.fact)).toStrictEqual([
			{ code: 'header-not-recognized', profile: 'Revolut' }
		]);
		expect(counts(result)).toMatchObject({ totalRows: 4, fileLevelRefusals: 1, invalidRows: 0 });
	});

	it('reports zero rows when the file was never opened, which is the honest figure there', () => {
		// The one case where 0 is true rather than a placeholder: the size check returns before a
		// single row is parsed, so there is no count to give.
		const result = parseCsvTransactions(refusedFile(50), { maxBytes: 10 });

		expect(result.invalidRows[0].fact.code).toBe('file-too-large');
		expect(counts(result)).toMatchObject({ totalRows: 0, fileLevelRefusals: 1, invalidRows: 0 });
	});
});

describe('a bank footer is a line we read correctly, not a line that failed', () => {
	const BANQUE_POPULAIRE_HEADER =
		'Date de comptabilisation;Libelle simplifie;Libelle operation;Reference;Informations complementaires;Type operation;Categorie;Sous categorie;Debit;Credit;Date operation;Date de valeur;Pointage operation';

	const ONE_ROW =
		'24/06/2026;CARREFOUR;PAIEMENT CB CARREFOUR;REF001;;Carte bancaire;Courses;Supermarche;-42,90;;23/06/2026;24/06/2026;0';

	it('leaves the footer out of the rows read and out of the invalid count', () => {
		const result = parseCsvTransactions(
			`${BANQUE_POPULAIRE_HEADER}\n${ONE_ROW}\nSolde au 24/06/2026;123,45`
		);

		// Two physical data lines, one of which is a footer we recognised. One transaction, nothing
		// invalid, and one row read: calling the footer a failure in a box labelled « Lignes
		// invalides » is a false statement about a line nothing was wrong with.
		expect(counts(result)).toStrictEqual({
			totalRows: 1,
			validRows: 1,
			invalidRows: 0,
			fileLevelRefusals: 0,
			duplicateRows: 0
		});
	});

	it('still lists the footer, because a silent skip is the other way to be wrong about it', () => {
		const result = parseCsvTransactions(
			`${BANQUE_POPULAIRE_HEADER}\n${ONE_ROW}\nSolde au 24/06/2026;123,45`
		);

		expect(result.invalidRows).toStrictEqual([
			{ scope: { kind: 'row', line: 3 }, fact: { code: 'footer-ignored' }, field: 'line' }
		]);
	});
});

describe('a headerless file refused through its mapping counts its first line', () => {
	it('does not lose the first row to a header that is not there', () => {
		const broken: ColumnMappingInput = {
			matchBy: 'name',
			dateColumn: 'jour',
			labelColumn: 'intitule',
			amountColumn: 'somme',
			categoryColumn: null,
			dateIndex: 2,
			labelIndex: null,
			amountIndex: null,
			categoryIndex: null,
			columnCount: 3
		};

		const result = parseCsvTransactions(
			'24/06/2026;CARREFOUR;-24,90\n21/06/2026;SALAIRE;1850,00\n03/06/2026;SNCF;-58,00\n',
			{ profile: 'mapped', columnMapping: broken, hasHeaderRow: false }
		);

		// Three lines, all of them data. The refusal path subtracted a header row it had been told
		// was not there, so it reported two.
		expect(result.invalidRows[0].fact.code).toBe('mapping-invalid');
		expect(counts(result)).toMatchObject({ totalRows: 3, invalidRows: 0, fileLevelRefusals: 1 });
	});
});

describe('the rows a parser CLASSIFIED always partition', () => {
	/**
	 * The property the cases above are instances of, and it is narrower than it first looks.
	 *
	 * `totalRows === validRows + invalidRows` holds **only when the parser actually read the rows**.
	 * A file refused for its header has real rows and classifies none of them: they were never
	 * examined, so they are neither valid nor invalid, and a sum over them is not merely unequal, it
	 * is meaningless. The first draft of this test asserted the unconditional form and went red on
	 * exactly that case, which is the finding rather than a fixture problem.
	 *
	 * This is also the whole argument for the screen not presenting the four as an equation. The
	 * invariant is real, it is worth pinning, and it is conditional, so a reader cannot be handed
	 * four tiles and left to subtract.
	 */
	const CORPUS: Array<[string, string]> = [
		['every row valid', 'date;label;amount\n01/06/2026;Courses;-12,30\n02/06/2026;Salaire;1850,00'],
		['every row refused', 'date;label;amount\n99/99/9999;Courses;-12,30\n99/99/9999;Loyer;-700'],
		['some rows refused', 'date;label;amount\n01/06/2026;Courses;-12,30\n99/99/9999;Loyer;-700'],
		['a row with no amount', 'date;label;amount\n01/06/2026;Courses;\n02/06/2026;Salaire;1850,00'],
		['a short row', 'date;label;amount\n01/06/2026;Courses\n02/06/2026;Salaire;1850,00'],
		['the header refused', refusedFile(6)],
		['nothing readable', 'date;label;amount\n']
	];

	it.each(CORPUS)(
		'%s: rows read is valid plus invalid once the rows were read',
		(_name, content) => {
			const { totalRows, validRows, invalidRows, fileLevelRefusals } =
				parseCsvTransactions(content).summary;

			if (fileLevelRefusals > 0) {
				// Refused whole: the rows are counted because the file has them, and classified as
				// nothing because the parser never looked at one.
				expect(validRows + invalidRows).toBe(0);
				return;
			}

			expect(validRows + invalidRows).toBe(totalRows);
		}
	);

	it('has a corpus that reaches both arms of that condition', () => {
		// Otherwise the branch above is an assertion nothing runs: a corpus with no refused-whole
		// file would pass with the early return deleted, and a corpus of only refused-whole files
		// would pass with the sum deleted.
		const summaries = CORPUS.map(([, content]) => parseCsvTransactions(content).summary);

		expect(summaries.filter((summary) => summary.fileLevelRefusals > 0)).toHaveLength(2);
		expect(summaries.filter((summary) => summary.fileLevelRefusals === 0)).toHaveLength(5);
	});

	it('has a corpus that actually exercises both sides of the sum', () => {
		// The partition is satisfied trivially by a corpus where every file imports cleanly, so the
		// absolute figures sit beside it: the assertion above is only worth running because these
		// two are non-zero.
		const summaries = CORPUS.map(([, content]) => parseCsvTransactions(content).summary);

		expect(summaries.filter((summary) => summary.invalidRows > 0)).toHaveLength(4);
		expect(summaries.filter((summary) => summary.validRows > 0)).toHaveLength(4);
	});
});
