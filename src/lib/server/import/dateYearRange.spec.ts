import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from './csv';
import { csvProfileParsers, resolveProfile } from './registry';
import { BANQUE_POPULAIRE_HEADERS } from './profiles/banque-populaire';
import { MAISON_V2_HEADER } from './profiles/maison-v2';
import { MAISON_V3_HEADER } from './profiles/maison-v3';
import { normalizeParsedRows, parseRows, readRowDate } from './utils/csv';
import type { CsvImportOptions, CsvProfileParser } from './types';
import type { ColumnMappingInput } from './mapping/model';

/**
 * #758: a year no engine stores faithfully is refused ON THE ROW, with its own reason, on EVERY
 * parse path.
 *
 * ## What was measured, and why the refusal belongs at the parse
 *
 * The parser accepted any four-digit year. Written through `persistImportedTransactions` and read
 * back (2026-09-27, three engines): MariaDB keeps `0000-01-16` in the column and the application
 * reads it back as `2000-01-16`, and every year from 0001 to 0099 comes back in 1950 to 2049;
 * PostgreSQL throws `22008` for year 0000. SQLite stores all of them. So the same file wrote a
 * wrong date that looks right on one engine and failed the whole import on another. The table is
 * in the PR that closes #758, and `storableYears.db-smoke.ts` re-measures it on each engine.
 *
 * ## THE PATHS ARE ENUMERATED FROM THE REGISTRY, not from a list somebody keeps
 *
 * `every registered parser has a case` compares the parsers the cases below actually reached
 * against `csvProfileParsers` itself, by identity. A profile registered later without a case here
 * fails that test before it can import a year 0000 row. `mapped` is routed around the registry
 * (`csv.ts`), so it is named here explicitly; it is the path both the designation screen and the
 * correction door parse through.
 *
 * ## Breaks, each run separately and restored
 *
 * - The range check removed from `readRowDate`: red on every « refuses » case below, each one
 *   reading `transaction-invalid` (the domain's backstop in `validateTransaction`) instead of
 *   `date-out-of-range`. Separates « refused with its reason » from « refused as an invalid
 *   transaction with no cell and no column ».
 * - One profile reading its date through `readDateCell` instead of `readRowDate`: red on that
 *   profile's case alone. Separates « this path goes through the one reading » from « it skips it ».
 * - The bound moved by one on either side: see `storableYears.spec.ts`, which owns the literals.
 */

const OUT_OF_RANGE = '31/12/0999';
const FIRST_DAY = '01/01/1000';
const LAST_DAY = '31/12/9999';

const MAISON_V1_HEADER = 'date;libelle;categorie;montant;type;nature;source_bancaire';

const MAPPING: ColumnMappingInput = {
	matchBy: 'name',
	dateColumn: 'jour',
	labelColumn: 'intitule operation',
	amountColumn: 'somme',
	categoryColumn: null,
	dateIndex: null,
	labelIndex: null,
	amountIndex: null,
	categoryIndex: null,
	columnCount: 3
};

interface Case {
	path: string;
	profile: string;
	/** The column the refusal names, as the profile names it in every other date refusal. */
	column: string;
	header: string;
	row: (date: string) => string;
	options?: CsvImportOptions;
}

const CASES: Case[] = [
	{
		path: 'generic, through its alias table',
		profile: 'generic',
		column: 'date',
		header: 'Date,Description,Amount',
		row: (date) => `${date},COFFEE,-4.50`
	},
	{
		path: 'mapped, the designation screen and the correction door',
		profile: 'mapped',
		column: 'jour',
		header: 'Jour;Intitule operation;Somme',
		row: (date) => `${date};CARREFOUR MARKET;-24,90`,
		options: { profile: 'mapped', columnMapping: MAPPING, dateOrderPromptedClientSide: true }
	},
	{
		path: 'banque-populaire, through its three date candidates',
		profile: 'banque-populaire',
		column: 'Date operation',
		header: BANQUE_POPULAIRE_HEADERS.join(';'),
		row: (date) =>
			`${date};CARREFOUR;CARREFOUR MARKET;REF1;;CARTE;Courses;Alimentation;-24,90;;${date};${date};`
	},
	{
		path: 'revolut, through its two date candidates',
		profile: 'revolut',
		column: 'Date de fin',
		header: 'Type,Produit,Date de début,Date de fin,Description,Montant,Frais,Devise,État,Solde',
		row: (date) => `CARD_PAYMENT,Current,${date},${date},Tesco,-12.30,0.00,EUR,TERMINÉ,500.00`
	},
	{
		path: 'maison v1, the seven-column export',
		profile: 'maison',
		column: 'date',
		header: MAISON_V1_HEADER,
		row: (date) => `${date};Salaire;Revenus;1500.00;income;income;csv`
	},
	{
		path: 'maison v2, the ten-column export',
		profile: 'maison',
		column: 'date',
		header: MAISON_V2_HEADER,
		row: (date) => `${date};Leroy Merlin;Maison;-80.00;expense;spending;csv;-80.00;1/1;Maison`
	},
	{
		path: 'maison v3, which delegates to v2',
		profile: 'maison',
		column: 'date',
		header: MAISON_V3_HEADER,
		row: (date) =>
			`${date};Leroy Merlin;Maison;-80.00;expense;spending;csv;-80.00;1/1;Maison;Compte courant`
	}
];

function fileOf(c: Case): string {
	return [c.header, c.row(OUT_OF_RANGE), c.row(FIRST_DAY), c.row(LAST_DAY)].join('\n');
}

describe('a year no engine stores faithfully is refused on every parse path', () => {
	/**
	 * Separates « refused on its row with the range reason, naming the cell as written » from
	 * « imported » (the defect) and from « refused as something else ». The whole fact is compared,
	 * so a refusal naming the wrong column or a reformatted value is red too.
	 */
	it.each(CASES)('$path refuses the year 0999 row with date-out-of-range', (c) => {
		expect.assertions(2);

		const result = parseCsvTransactions(fileOf(c), c.options);

		// The file reached the parser it was written for, or the case is about another path.
		expect(result.summary.profile).toBe(c.profile);
		expect(result.invalidRows).toEqual([
			{
				scope: { kind: 'row', line: 2 },
				fact: { code: 'date-out-of-range', column: c.column, value: OUT_OF_RANGE },
				field: c.column
			}
		]);
	});

	/**
	 * The control, and the other side of the lower bound: the first and the last storable day import
	 * as themselves. Separates « the range admits its own bounds » from « a check that refuses
	 * everything », which would satisfy the test above on its own.
	 */
	it.each(CASES)('$path imports the first and the last storable day unchanged', (c) => {
		expect.assertions(1);

		const result = parseCsvTransactions(fileOf(c), c.options);

		expect(result.transactions.map((transaction) => transaction.date)).toEqual([
			'1000-01-01',
			'9999-12-31'
		]);
	});

	/**
	 * THE ENUMERATION. Separates « every parser in the registry is exercised above » from « a parser
	 * was registered and no case reaches it », which would leave both `it.each` blocks green over a
	 * path that was never read. Compared by identity against `csvProfileParsers`, not against a list
	 * of names, because three parsers share the name `maison`.
	 */
	it('every registered parser has a case, and so does mapped', () => {
		expect.assertions(3);

		const reached = new Set<CsvProfileParser>();
		let mappedCases = 0;
		for (const c of CASES) {
			if (c.options?.profile === 'mapped') {
				mappedCases += 1;
				continue;
			}
			const header = normalizeParsedRows(parseRows(fileOf(c)))[0].cells;
			const parser = resolveProfile(header, 'auto');
			if (parser) reached.add(parser);
		}

		// The absolute figure beside the set comparison: an empty registry compares equal to nothing.
		expect(csvProfileParsers.length).toBeGreaterThan(0);
		expect([...reached]).toEqual(expect.arrayContaining(csvProfileParsers));
		expect(mappedCases).toBe(1);
	});
});

describe('readRowDate, the one reading of a row date', () => {
	/**
	 * Separates « the range is judged AFTER the fall-through chose a cell » from « an out-of-range
	 * cell counts as unreadable and the next column is read instead ». The second would import the
	 * row under a DIFFERENT column's date without a word, which is the silent value change
	 * `firstReadableDate`'s docstring warns the fall-through can produce.
	 */
	it('refuses an out-of-range first candidate rather than falling through to the next column', () => {
		expect.assertions(1);
		expect(
			readRowDate([
				{ column: 'Date operation', value: '16/01/0000' },
				{ column: 'Date de comptabilisation', value: '17/01/2026' }
			])
		).toEqual({
			kind: 'refused',
			fact: { code: 'date-out-of-range', column: 'Date operation', value: '16/01/0000' }
		});
	});

	/**
	 * Separates « names the column the date was READ from » from « names the first candidate »:
	 * when the first is blank, the date came from the second, and that is the cell to show.
	 */
	it('names the candidate the out-of-range date was read from', () => {
		expect.assertions(1);
		expect(
			readRowDate([
				{ column: 'Date operation', value: '' },
				{ column: 'Date de comptabilisation', value: '0000-01-16 10:00:00' }
			])
		).toEqual({
			kind: 'refused',
			fact: {
				code: 'date-out-of-range',
				column: 'Date de comptabilisation',
				value: '0000-01-16 10:00:00'
			}
		});
	});

	it('keeps the unreadable case as invalid-date, naming the first candidate as before', () => {
		expect.assertions(1);
		expect(
			readRowDate([
				{ column: 'Date de fin', value: 'CARD_PAYMENT' },
				{ column: 'Date de début', value: '' }
			])
		).toEqual({
			kind: 'refused',
			fact: { code: 'invalid-date', column: 'Date de fin', value: 'CARD_PAYMENT' }
		});
	});

	it('reads an in-range date', () => {
		expect.assertions(1);
		expect(readRowDate([{ column: 'date', value: '01/01/1000' }])).toEqual({
			kind: 'date',
			date: '1000-01-01'
		});
	});

	/**
	 * #623: `column` is a HEADER CELL, and on the `mapped` profile it is the user's own file's
	 * header, not a literal role name. `value` was already bounded through `refusalCellValue`;
	 * `column` was not, so an oversized header reached this fact, and therefore the page's data on
	 * every failed import, at whatever length the file's own upload cap allowed. Same bound, same
	 * function, as `value` gets: sanitise and cut at 64 characters. Separates « the column is
	 * bounded like the value beside it » from « only the value is ».
	 */
	it('bounds an oversized column name exactly as it bounds the value', () => {
		expect.assertions(1);
		const oversizedColumn = 'x'.repeat(70);
		expect(readRowDate([{ column: oversizedColumn, value: 'CARD_PAYMENT' }])).toEqual({
			kind: 'refused',
			fact: { code: 'invalid-date', column: `${'x'.repeat(64)}...`, value: 'CARD_PAYMENT' }
		});
	});

	/** Same bound, the `date-out-of-range` branch: separates the two branches' `column` handling. */
	it('bounds an oversized column name on the date-out-of-range branch too', () => {
		expect.assertions(1);
		const oversizedColumn = 'y'.repeat(70);
		expect(readRowDate([{ column: oversizedColumn, value: '16/01/0000' }])).toEqual({
			kind: 'refused',
			fact: {
				code: 'date-out-of-range',
				column: `${'y'.repeat(64)}...`,
				value: '16/01/0000'
			}
		});
	});
});
