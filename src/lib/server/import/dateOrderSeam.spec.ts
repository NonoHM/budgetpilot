import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from './csv';
import { csvProfileParsers } from './registry';
import { BANQUE_POPULAIRE_HEADERS } from './profiles/banque-populaire';
import { REVOLUT_HEADERS } from './profiles/revolut';
import { MAISON_V2_HEADER } from './profiles/maison-v2';
import { MAISON_V3_HEADER } from './profiles/maison-v3';
import type { ColumnMappingInput } from './mapping/model';

/**
 * The date order is DERIVED from the file at the one door, and the option is an override.
 *
 * ## The fixture, and the two independent signals it carries
 *
 * A Chase statement: month-first, and `Posting Date` is deliberately absent from the alias table
 * (`columnAliases.ts`, with a DO NOT ADD beside it), so this file reaches the parser only through
 * a designation the user made. That is not a curiosity, it is the centre of #433: the designation
 * screen exists because the bank was not recognised, an unrecognised bank is disproportionately
 * not European, and not European is where month-first lives.
 *
 * Measured on `main` before this change, and both figures move for different reasons:
 *
 * - **3 rows in, 2 out, 1 refused `invalid-date`**, because `08/15/2026` read day-first is day 8
 *   of month 15, which is not a date. The rows that PROVE the order were being discarded one at
 *   a time. The derivation converts them into the proof that settles the file.
 * - **The two survivors displaced 146 and 145 days**, silently, with a correct-looking summary.
 *
 * So a change that fixed only the refusal or only the dates cannot turn this green.
 */

const CHASE_HEADER = 'Posting Date,Description,Amount';
/** `08/15/2026` puts 15 second, which no month can be: the column RESOLVES month-first. */
const CHASE_RESOLVING = [
	CHASE_HEADER,
	'06/01/2026,STARBUCKS,-4.50',
	'07/02/2026,WHOLE FOODS,-61.20',
	'08/15/2026,PAYROLL,2400.00'
].join('\n');

const CHASE_MAPPING: ColumnMappingInput = {
	matchBy: 'name',
	dateColumn: 'Posting Date',
	labelColumn: 'Description',
	amountColumn: 'Amount',
	categoryColumn: null,
	dateIndex: null,
	labelIndex: null,
	amountIndex: null,
	categoryIndex: null,
	columnCount: 3
};

/** A mapping pointing at a column this file does not have. */
const ABSENT_COLUMN_MAPPING: ColumnMappingInput = { ...CHASE_MAPPING, dateColumn: 'Trade Date' };

function mapped(content: string, mapping: ColumnMappingInput = CHASE_MAPPING) {
	return parseCsvTransactions(content, { profile: 'mapped', columnMapping: mapping });
}

describe('the date order is read off the file at the single door', () => {
	/**
	 * Separates "the column's own proof decided the file" from "the file was read day-first and
	 * its resolving rows thrown away". The two differ in the refusal count AND in the dates.
	 */
	it('reads a designated month-first column month-first, and keeps the row that proved it', () => {
		expect.assertions(4);

		const result = mapped(CHASE_RESOLVING);

		expect(result.summary.validRows).toBe(3);
		expect(result.summary.invalidRows).toBe(0);
		expect(result.summary.fileLevelRefusals).toBe(0);
		expect(result.transactions.map((transaction) => transaction.date)).toEqual([
			'2026-06-01',
			'2026-07-02',
			'2026-08-15'
		]);
	});

	/**
	 * THE CONTROL for the test above, and it is what makes those dates a measurement rather than
	 * a coincidence. Separates "the fixture is ambiguous and the derivation decided it" from "the
	 * fixture reads the same either way", which would let a parser ignoring the whole mechanism
	 * pass. Same three cells, read under the order this file does NOT prove.
	 */
	it('reads the same three cells 146 and 145 days earlier under the order the file denies', () => {
		expect.assertions(1);

		const dayFirst = ['06/01/2026', '07/02/2026'].map((cell) => {
			const [day, month, year] = cell.split('/');
			return `${year}-${month}-${day}`;
		});

		expect(dayFirst).toEqual(['2026-01-06', '2026-02-07']);
	});

	/**
	 * Separates "a file proving both readings is refused as a file" from "it is read under one of
	 * them and the other's rows are refused one by one". `06/24/2026` and `24/06/2026` each prove
	 * the opposite order, so no single reading fits.
	 */
	it('refuses a column that proves both readings, naming one cell of each', () => {
		expect.assertions(4);

		const result = parseCsvTransactions(
			['Date,Description,Amount', '24/06/2026,A,-1.00', '06/24/2026,B,-2.00'].join('\n')
		);

		expect(result.transactions).toEqual([]);
		expect(result.summary.fileLevelRefusals).toBe(1);
		expect(result.summary.totalRows).toBe(2);
		expect(result.invalidRows[0].fact).toEqual({
			code: 'mixed-date-order',
			dayFirst: '24/06/2026',
			monthFirst: '06/24/2026'
		});
	});

	/**
	 * Separates "the cells this refusal names are bounded and sanitised" from "a user's own upload
	 * decides what goes into the page's data".
	 *
	 * `AMBIGUOUS_DATE_PATTERN` ends in `([\s\S]*)`, so the evidence a verdict carries is the WHOLE
	 * trimmed cell, not the ten characters of the date. Measured before this assertion existed: a
	 * 5,010 character cell reached the refusal fact at 5,010 characters, and `24/06/2026` followed
	 * by a tab and a spreadsheet formula reached it raw. Bounded only by the file size cap, which
	 * is 256,000 bytes.
	 *
	 * `refusalCellValue` is the repository's answer and its docstring names this exact hazard:
	 * sanitise AND bound, « use this for anything lifted from a cell, never `sanitizeImportedText`
	 * alone ». Every other refusal in this directory already goes through it; this one is the new
	 * one and had to join them.
	 */
	it('bounds and sanitises the cells the mixed refusal names', () => {
		expect.assertions(3);

		const blob = 'A'.repeat(5000);
		const result = parseCsvTransactions(
			[
				'Date,Description,Amount',
				`"24/06/2026\t=cmd|'/c calc'!A1",A,-1.00`,
				`06/24/2026${blob},B,-2.00`
			].join('\n')
		);

		const fact = result.invalidRows[0].fact;
		expect(fact.code).toBe('mixed-date-order');
		if (fact.code !== 'mixed-date-order') return;
		// 64 plus the three-character ellipsis `refusalCellValue` appends.
		expect(fact.monthFirst.length).toBeLessThanOrEqual(67);
		// The tab is collapsed to a single space rather than carried into the page's data.
		expect(fact.dayFirst).toBe("24/06/2026 =cmd|'/c calc'!A1");
	});

	/**
	 * Separates "a resolved column is read and nothing is asked" from "any file touching the new
	 * machinery acquires a refusal". A file that settles its own order has no question in it.
	 */
	it('asks nothing of a file that resolves its own order', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(
			['Date,Description,Amount', '24/06/2026,A,-1.00', '06/01/2026,B,-2.00'].join('\n')
		);

		expect(result.summary.fileLevelRefusals).toBe(0);
		expect(result.summary.validRows).toBe(2);
		expect(result.transactions.map((t) => t.date)).toEqual(['2026-06-24', '2026-01-06']);
	});

	/**
	 * Separates "an ISO column is untouched by the verdict and by the override" from "the new
	 * machinery reaches a file it has nothing to say about". ISO 8601 carries its own order, so
	 * both readings of this file are the same file and an override has nothing to apply to.
	 */
	it('leaves an ISO column alone, override or not', () => {
		expect.assertions(2);

		const iso = ['Date,Description,Amount', '2026-06-01,A,-1.00', '2026-08-15,B,-2.00'].join('\n');
		const plain = parseCsvTransactions(iso);
		const overridden = parseCsvTransactions(iso, { dateOrder: 'month-first' });

		expect(plain.transactions.map((t) => t.date)).toEqual(['2026-06-01', '2026-08-15']);
		expect(overridden.transactions.map((t) => t.date)).toEqual(
			plain.transactions.map((t) => t.date)
		);
	});

	/**
	 * Separates "a declaration pointing at an absent column returns nothing" from "it throws, or
	 * reads a neighbouring column". The file then reaches its ORDINARY refusal, which is the one
	 * that can tell the user what to do about it.
	 */
	it('does not crash when a declaration names a column this file does not have', () => {
		expect.assertions(2);

		const result = mapped(CHASE_RESOLVING, ABSENT_COLUMN_MAPPING);

		expect(result.transactions).toEqual([]);
		expect(result.invalidRows.map((refusal) => refusal.fact.code)).toEqual([
			'mapping-columns-missing'
		]);
	});
});

/**
 * Every registered parser declares at least one date column against a header it matches.
 *
 * ## What this can and cannot do, stated rather than implied
 *
 * A required `dateColumns` member makes OMISSION unrepresentable: a registry entry without one is
 * a compile error and no discipline is involved. It does NOT make a LIE unrepresentable, because
 * `dateColumns: () => []` typechecks and silently switches the derivation off for that profile,
 * which is #587's shape exactly. This test is what narrows that gap, and it is a test rather than
 * a type, so it is « likely to be noticed » and not « impossible ». Do not read it as the first.
 *
 * The coverage assertion is the part that binds a FUTURE profile: a new registry entry with no
 * header beside it fails on the length before anything else runs, so the fixture cannot be
 * forgotten, and once it exists the emptiness assertion has something real to run against.
 *
 * A `sampleHeader` field ON the registry entry was considered and rejected: `generic` matches
 * everything, so its sample would be a fiction, and a fixture stored in the registry configures a
 * derivable thing, which fails one rule to patch another.
 */
const HEADER_PER_ENTRY: string[][] = [
	BANQUE_POPULAIRE_HEADERS,
	REVOLUT_HEADERS,
	MAISON_V3_HEADER.split(';'),
	MAISON_V2_HEADER.split(';'),
	'date;libelle;categorie;montant;type;nature;source_bancaire'.split(';'),
	['Date', 'Description', 'Amount']
];

describe('every registered profile declares its date columns', () => {
	/**
	 * Separates "every registry entry has a header to be tested against" from "a profile was
	 * added and this file did not notice". Red here means add the new profile's header below.
	 */
	it('carries one header per registry entry', () => {
		expect.assertions(1);
		expect(HEADER_PER_ENTRY.length).toBe(csvProfileParsers.length);
	});

	/**
	 * Separates "this header reaches the entry it was written for" from "it falls through to a
	 * later one". Without it, `generic` (whose match returns true for everything) would silently
	 * stand in for any entry whose fixture stopped matching.
	 */
	it.each(csvProfileParsers.map((parser, index) => ({ index, profile: parser.profile })))(
		'entry $index ($profile) matches its own header',
		({ index }) => {
			expect.assertions(1);
			expect(csvProfileParsers[index].matches(HEADER_PER_ENTRY[index])).toBe(true);
		}
	);

	/**
	 * Separates "this profile declares a real date column" from "it declares an empty list and
	 * the derivation silently does not apply to it".
	 */
	it.each(csvProfileParsers.map((parser, index) => ({ index, profile: parser.profile })))(
		'entry $index ($profile) declares at least one date column',
		({ index }) => {
			expect.assertions(1);
			expect(csvProfileParsers[index].dateColumns(HEADER_PER_ENTRY[index]).length).toBeGreaterThan(
				0
			);
		}
	);
});
