import { describe, expect, it } from 'vitest';
import { parseCsvTransactionRows } from './csv';
import { parseRows } from './utils/csv';
import type { UntrustedColumnMapping } from './mapping/model';

/**
 * A file whose first line is DATA, and the transaction that was being eaten.
 *
 * ## The defect, measured through the route before this file existed
 *
 * A four-line headerless file, designated with « la première ligne contient des données » ticked,
 * recorded `rowCount: 3`. The parser consumed row 0 as a header, so the user lost one transaction
 * per import, silently, on a file that is not malformed in any way: every row carries the same
 * field count and there is no title row to find.
 *
 * **The file is valid. The assumption was ours.** `parseResolvedRows` did `rows.slice(1)`
 * unconditionally, because until the designation screen existed every file this parser saw did
 * have a header row.
 *
 * ## What this is NOT
 *
 * It is not the malformed case. A header row of five names over data rows of four values is
 * refused per row with `bad-column-count`, carrying `expected` and `actual`, scoped to the real
 * line — measured across all four profiles, and unchanged by this file. Nothing pads, truncates
 * or drops. The two were worth separating: one is our bug, the other is the file's.
 */

const HEADERLESS = [
	'2026-06-01,Mercerie Lafayette,-45.20',
	'2026-06-02,Pharmacie du Pont,-18.90',
	'2026-06-03,Salaire,2450.00',
	'2026-06-07,Fleuriste Bellevue,-31.00'
].join('\n');

/** Positional, because a headerless file has no names to match by. */
const BY_POSITION: UntrustedColumnMapping = {
	matchBy: 'position',
	dateColumn: null,
	labelColumn: null,
	amountColumn: null,
	categoryColumn: null,
	dateIndex: 0,
	labelIndex: 1,
	amountIndex: 2,
	categoryIndex: null,
	columnCount: 3
};

function parse(content: string, hasHeaderRow: boolean) {
	return parseCsvTransactionRows(parseRows(content), {
		profile: 'mapped',
		columnMapping: BY_POSITION,
		hasHeaderRow,
		categorizationRules: []
	});
}

describe('a file whose first line is data', () => {
	it('reads every row, including the first', () => {
		expect.assertions(4);

		const result = parse(HEADERLESS, false);

		// FOUR, where the defect produced three. The absolute figure rather than "more than
		// before": a parser that read five would satisfy "no longer eats one".
		expect(result.summary.totalRows).toBe(4);
		expect(result.transactions).toHaveLength(4);
		expect(result.invalidRows).toHaveLength(0);
		// Named, because losing the FIRST row is the whole defect and a count alone would pass on
		// a parser that dropped the last one instead.
		expect(result.transactions[0].label).toBe('Mercerie Lafayette');
	});

	it('carries the first row into the period and the totals', () => {
		expect.assertions(2);

		const result = parse(HEADERLESS, false);

		// 1 June is the first row. A period starting on 2 June is the defect, reported as a fact
		// about the user's money rather than as a row count.
		expect(result.summary.period).toEqual({ from: '2026-06-01', to: '2026-06-07' });
		expect(result.summary.totalDebitCents).toBe(4520 + 1890 + 3100);
	});

	/**
	 * The direction this change is NOT moving in, and the one that would be catastrophic.
	 *
	 * Every ordinary import has a header row. A parser that stopped consuming it would read the
	 * header as a transaction on EVERY file the application handles — a labelled `montant` row
	 * with an unparseable amount, on every statement anyone imports.
	 */
	it('still consumes the header row of a file that has one', () => {
		expect.assertions(3);

		const withHeader = `date,label,amount\n${HEADERLESS}`;
		const result = parse(withHeader, true);

		expect(result.summary.totalRows).toBe(4);
		expect(result.transactions).toHaveLength(4);
		expect(result.transactions[0].label).toBe('Mercerie Lafayette');
	});

	/** And the default is the ordinary case, so a caller that says nothing keeps today's behaviour. */
	it('treats an unspecified hasHeaderRow as a file that has one', () => {
		expect.assertions(1);

		const withHeader = `date,label,amount\n${HEADERLESS}`;
		const result = parseCsvTransactionRows(parseRows(withHeader), {
			profile: 'mapped',
			columnMapping: BY_POSITION,
			categorizationRules: []
		});

		expect(result.summary.totalRows).toBe(4);
	});

	/**
	 * Two identical DATA values in row 0 are not a duplicate header.
	 *
	 * `mapped` refuses a file whose header row repeats a name, because `toRecord` lets the later
	 * column overwrite the earlier one. Run against a headerless file that check reads a data row,
	 * so two rows that happen to carry the same value in two columns would refuse the whole file
	 * — a refusal about the user's data pretending to be about their columns.
	 */
	it('does not read row 0 as a header row for the duplicate-column check', () => {
		expect.assertions(2);

		// Row 0 repeats a value across two columns. Deliberately NOT an amount: two equal amounts
		// trip `detectComplementAmountColumn`, which is a data-driven heuristic and a different
		// question — a fixture that fires it would report the wrong guard as the one under test.
		const result = parse('SOLDE,SOLDE,-45.20\n2026-06-02,Pharmacie,-18.90', false);

		expect(result.invalidRows.map((row) => row.fact.code)).not.toContain('duplicate-column');
		// Both rows READ. The first is refused on its own merits — `SOLDE` is not a date — rather
		// than the whole file being refused for a header defect it does not have.
		expect(result.summary.totalRows).toBe(2);
	});
});

/**
 * #1200's contradiction pass, F1: THE DATE VERDICT READS THE DESIGNATED INDEX. A positional
 * mapping resolves each role to its line 1 cell TEXT (`applyByPosition`), and the verdict used to
 * look that text up with `indexOf`, so on a line 1 that repeats a value it judged the FIRST equal
 * column while the screen judged the designated one. Here the member designates column 1, which
 * proves day-first (13/01); column 0 reads both ways. The screen asks nothing, so no answer is
 * posted. Separates « the verdict is about the column the member designated » from « the verdict
 * is about an equal neighbour », which refuses a file the screen offers no way to answer.
 *
 * The STORED column is #1202's question (the parse reads the last equal column) and is not
 * asserted here: column 1 is also the last, so both readings of that question agree on this file.
 */
const EQUAL_ON_LINE_ONE = [
	'05/01/2026;05/01/2026;CARTE A;-10,00',
	'07/01/2026;13/01/2026;CARTE B;-20,00',
	'08/01/2026;09/01/2026;CARTE C;-30,00'
].join('\n');

describe('a headerless file whose line 1 repeats the date', () => {
	it('judges the date order on the designated column, not on an equal neighbour', () => {
		expect.assertions(2);
		const result = parseCsvTransactionRows(parseRows(EQUAL_ON_LINE_ONE), {
			profile: 'mapped',
			columnMapping: {
				...BY_POSITION,
				dateIndex: 1,
				labelIndex: 2,
				amountIndex: 3,
				columnCount: 4
			},
			hasHeaderRow: false,
			categorizationRules: []
		});
		expect(result.invalidRows.map((row) => row.fact.code)).toEqual([]);
		expect(result.transactions.map((transaction) => transaction.date)).toEqual([
			'2026-01-05',
			'2026-01-13',
			'2026-01-09'
		]);
	});
});

/**
 * #1202: EVERY ROLE IS READ AT ITS DESIGNATED INDEX. A positional mapping used to resolve each role
 * to its line 1 cell TEXT, and the row record was keyed by that text, so when line 1 repeats a
 * value the LAST equal column was stored. Each case puts the designated column FIRST of two equal
 * ones on line 1, so « the designated index » and « the last equal column » store different
 * values, and the assertion compares the whole stored column.
 */
function parseByPosition(content: string, indices: Partial<UntrustedColumnMapping>) {
	return parseCsvTransactionRows(parseRows(content), {
		profile: 'mapped',
		columnMapping: { ...BY_POSITION, ...indices },
		hasHeaderRow: false,
		categorizationRules: []
	});
}

describe('a headerless file whose line 1 repeats a value (#1202)', () => {
	it('stores the designated date column, with the order that column proves', () => {
		expect.assertions(2);
		// Column 0 proves day-first (15/06); column 1 reads both ways and equals column 0 on line 1.
		const result = parseByPosition(
			['05/06/2026;05/06/2026;CB A;-10,00', '15/06/2026;06/06/2026;CB B;-20,00'].join('\n'),
			{ dateIndex: 0, labelIndex: 2, amountIndex: 3, columnCount: 4 }
		);
		expect(result.invalidRows.map((row) => row.fact.code)).toEqual([]);
		expect(result.transactions.map((transaction) => transaction.date)).toEqual([
			'2026-06-05',
			'2026-06-15'
		]);
	});

	it('stores the designated amount column, not an equal balance after it', () => {
		expect.assertions(2);
		const result = parseByPosition(
			['2026-06-01;CB A;-10.00;-10.00', '2026-06-02;CB B;-20.00;-30.00'].join('\n'),
			{ dateIndex: 0, labelIndex: 1, amountIndex: 2, columnCount: 4 }
		);
		expect(result.invalidRows.map((row) => row.fact.code)).toEqual([]);
		expect(result.transactions.map((transaction) => transaction.amountCents)).toEqual([
			-1000, -2000
		]);
	});

	it('stores the designated label column, not an equal memo after it', () => {
		expect.assertions(2);
		const result = parseByPosition(
			['2026-06-01;CB A;CB A;-10.00', '2026-06-02;CB B;MEMO B;-20.00'].join('\n'),
			{ dateIndex: 0, labelIndex: 1, amountIndex: 3, columnCount: 4 }
		);
		expect(result.invalidRows.map((row) => row.fact.code)).toEqual([]);
		expect(result.transactions.map((transaction) => transaction.label)).toEqual(['CB A', 'CB B']);
	});

	it('stores the designated category column, not an equal column after it', () => {
		expect.assertions(2);
		const result = parseByPosition(
			['2026-06-01;CB A;-10.00;Courses;Courses', '2026-06-02;CB B;-20.00;Loisirs;Autre'].join(
				'\n'
			),
			{ dateIndex: 0, labelIndex: 1, amountIndex: 2, categoryIndex: 3, columnCount: 5 }
		);
		expect(result.invalidRows.map((row) => row.fact.code)).toEqual([]);
		expect(result.transactions.map((transaction) => transaction.category)).toEqual([
			'Courses',
			'Loisirs'
		]);
	});

	it('runs the separate-sign guard on the designated amount column (#320)', () => {
		expect.assertions(1);
		// Column 3 is the designated amount, unsigned, with its direction in column 4. Column 2
		// equals it on line 1 and is signed below, so a guard reading column 2 sees a signed amount
		// and lets every row through as income.
		const result = parseByPosition(
			[
				'2026-06-01;CB A;5.00;5.00;D',
				'2026-06-02;CB B;-3.00;7.00;C',
				'2026-06-03;CB C;-1.00;8.00;D'
			].join('\n'),
			{ dateIndex: 0, labelIndex: 1, amountIndex: 3, columnCount: 5 }
		);
		expect(result.invalidRows.map((row) => row.fact.code)).toEqual([
			'amount-sign-in-separate-column'
		]);
	});
});

/**
 * #1202's pass on the design note, finding 1: the index keys are for a file WITHOUT a header row,
 * not for a positional mapping. A restored backup can apply a positional mapping to a file that has
 * one, and its `Devise` column still declares the currency. Separates « keyed by the member's
 * header answer » from « keyed by the mapping's kind », which loses the declaration.
 */
describe('a positional mapping over a file with a header row', () => {
	it('still reads the currency the header row declares', () => {
		expect.assertions(1);
		const result = parseCsvTransactionRows(
			parseRows('Date;Libellé;Montant;Devise\n2026-06-01;CB A;-10.00;USD'),
			{
				profile: 'mapped',
				columnMapping: { ...BY_POSITION, columnCount: 4 },
				hasHeaderRow: true,
				categorizationRules: []
			}
		);
		expect(result.invalidRows.map((row) => row.fact.code)).toEqual(['unsupported-currency']);
	});
});
