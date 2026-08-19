import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from '../csv';
import type { ColumnMappingInput } from '../mapping/model';

/**
 * A user designates a `période` column as the date, on the designation screen. #366.
 *
 * This is the case #366 argues from and the reason it is worse than it used to be. Before the
 * mapping path, a profile WE wrote chose the date column. Now the user points the date role at a
 * column, from three sample values, and a column reading `01/01/2026 au 31/01/2026` is exactly the
 * one a hurried reader designates. Until this fix every row imported under 1 January: no refusal,
 * no warning, and every monthly total wrong with nothing on screen saying so.
 *
 * The header cells are FILE CONTENT, not identifiers, which is why they are French — the same
 * reasoning `mapped.spec.ts` records for its own fixture.
 */
const PERIODE_FILE =
	'Periode;Intitule operation;Somme\n' +
	'01/01/2026 au 31/01/2026;CARREFOUR MARKET;-24,90\n' +
	'01/01/2026 au 31/01/2026;SNCF;-58,00\n';

const SINGLE_DATE_FILE =
	'Periode;Intitule operation;Somme\n' +
	'24/06/2026;CARREFOUR MARKET;-24,90\n' +
	'21/06/2026;SNCF;-58,00\n';

const MAPPING: ColumnMappingInput = {
	matchBy: 'name',
	dateColumn: 'periode',
	labelColumn: 'intitule operation',
	amountColumn: 'somme',
	categoryColumn: null,
	dateIndex: null,
	labelIndex: null,
	amountIndex: null,
	categoryIndex: null,
	columnCount: 3
};

function importMapped(content: string) {
	return parseCsvTransactions(content, { profile: 'mapped', columnMapping: MAPPING });
}

describe('a période column designated as the date', () => {
	it('refuses every row instead of importing them all under the first date', () => {
		expect.assertions(3);

		const result = importMapped(PERIODE_FILE);

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows).toHaveLength(2);
		// The refusal names the column the USER designated, not a hardcoded `date` — a mapped file
		// need not contain a column by that name at all.
		expect(result.invalidRows.map((row) => row.fact)).toStrictEqual([
			{ code: 'invalid-date', column: 'periode', value: '01/01/2026 au 31/01/2026' },
			{ code: 'invalid-date', column: 'periode', value: '01/01/2026 au 31/01/2026' }
		]);
	});

	it('still imports the same designation when the column holds one date', () => {
		expect.assertions(3);

		// The control. Without it, a fix that refused every mapped file would pass the test above
		// and be reported as a success.
		const result = importMapped(SINGLE_DATE_FILE);

		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions.map((t) => t.date)).toStrictEqual(['2026-06-24', '2026-06-21']);
		// An absolute figure beside the emptiness assertion, per this repo's rule: a parser
		// returning nothing satisfies an empty `invalidRows` perfectly.
		expect(result.summary.totalDebitCents).toBe(8290);
	});
});
