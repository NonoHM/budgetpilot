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
