import { describe, expect, it } from 'vitest';
import { parseCsvTransactionRows } from './csv';
import { parseRows } from './utils/csv';
import type { UntrustedColumnMapping } from './mapping/model';

/**
 * #1211: on a file the member declared headerless, line 1 is a TRANSACTION, so it is evidence about
 * the account column like every other line, and none of its cells is a header name.
 *
 * The defect, by reading: the account-column check took `rows.slice(1)` whatever the answer, so a
 * statement whose line 1 named account A and every later line account B read as constant, #485's
 * refusal never fired, and the whole file was filed under one account. Every stored row looked real.
 *
 * Each case below is the same bytes read under the two answers, so the answer is the only variable.
 */

/** Two ISO 13616 IBANs whose mod-97 checks verify: a difference between them is proof. */
const IBAN_A = 'FR7630006000011234567890189';
const IBAN_B = 'DE89370400440532013000';

function file(firstAccount: string, laterAccount: string): string {
	return [
		`2026-06-01,${firstAccount},CB A,-10.00`,
		`2026-06-02,${laterAccount},CB B,-20.00`,
		`2026-06-03,${laterAccount},CB C,-30.00`
	].join('\n');
}

const BY_POSITION: UntrustedColumnMapping = {
	matchBy: 'position',
	dateColumn: null,
	labelColumn: null,
	amountColumn: null,
	categoryColumn: null,
	dateIndex: 0,
	labelIndex: 2,
	amountIndex: 3,
	categoryIndex: null,
	columnCount: 4
};

function parse(content: string, hasHeaderRow: boolean) {
	return parseCsvTransactionRows(parseRows(content), {
		profile: 'mapped',
		columnMapping: BY_POSITION,
		hasHeaderRow,
		categorizationRules: []
	});
}

describe('#1211: a headerless file is judged on every line, line 1 included', () => {
	// SEPARATES « line 1 is evidence » FROM « line 1 is skipped as a header ». Reddens on a
	// discriminant check that still slices line 1 off a headerless file.
	it('refuses a proven second account that only line 1 carries', () => {
		const result = parse(file(IBAN_A, IBAN_B), false);
		expect({
			refusals: result.invalidRows.map((row) => row.fact),
			imported: result.transactions.length
		}).toStrictEqual({ refusals: [{ code: 'multi-account-file', column: 1 }], imported: 0 });
	});

	// SEPARATES « the sample is the first DATA line » FROM « the sample is line 2 ». On a headerless
	// file the first data line is line 1, and its cell is the one the member sees first.
	it('asks about an unproven column with line 1 as its sample', () => {
		const result = parse(file('12345678', '87654321'), false);
		expect(result.invalidRows.map((row) => row.fact)).toStrictEqual([
			{ code: 'ambiguous-account-column', column: 1, sample: '12345678' }
		]);
	});

	// Calibration: the SAME bytes read with a header row. Line 1 is then names, the rest is constant,
	// and nothing is refused. Green before the fix and after it: the answer is what separates.
	it('reads the same bytes as one account when line 1 is declared a header', () => {
		const result = parse(file(IBAN_A, IBAN_B), true);
		expect({
			refusals: result.invalidRows.map((row) => row.fact.code),
			imported: result.transactions.length
		}).toStrictEqual({ refusals: [], imported: 2 });
	});

	// Guards against over-refusal: a headerless file naming one account on every line imports whole.
	it('imports a headerless file whose every line names the same account', () => {
		const result = parse(file(IBAN_B, IBAN_B), false);
		expect({
			refusals: result.invalidRows.map((row) => row.fact.code),
			imported: result.transactions.length
		}).toStrictEqual({ refusals: [], imported: 3 });
	});
});

/**
 * Pass A on #1211, F1: lines 2 onward are data under BOTH answers, so a contradiction among them is
 * evidence whatever line 1 holds. Counting line 1 must never weaken the verdict they give: a blank
 * or non-identifier cell there disqualifies the column under the blank-cell rule, and would turn a
 * proven second account into « nothing to decide ».
 */
describe('#1211: counting line 1 never removes evidence', () => {
	// SEPARATES « never weaker than lines 2 onward » FROM « line 1 decides alone »: a blank on line 1
	// alone would drop the column, and three rows from two accounts would file as one.
	it('refuses two proven accounts on lines 2 and 3 whatever line 1 holds', () => {
		const result = parse(
			[
				'2026-06-01,,CB A,-10.00',
				`2026-06-02,${IBAN_A},CB B,-20.00`,
				`2026-06-03,${IBAN_B},CB C,-30.00`
			].join('\n'),
			false
		);
		expect({
			refusals: result.invalidRows.map((row) => row.fact),
			imported: result.transactions.length
		}).toStrictEqual({ refusals: [{ code: 'multi-account-file', column: 1 }], imported: 0 });
	});

	// The same through a header row the member called data: its cell names no identifier.
	it('refuses a two-account export whose header row was answered as data', () => {
		const result = parse(
			[
				'date,iban,label,amount',
				`2026-06-02,${IBAN_A},CB B,-20.00`,
				`2026-06-03,${IBAN_B},CB C,-30.00`
			].join('\n'),
			false
		);
		expect(result.invalidRows.map((row) => row.fact).at(-1)).toStrictEqual({
			code: 'multi-account-file',
			column: 1
		});
		expect(result.transactions).toHaveLength(0);
	});

	// SEPARATES « proof stays proof » FROM « line 1 downgrades it to a question »: an 8-digit cell
	// above two verified IBANs makes the column unproven over every line, and an unproven column can
	// be answered « not an account » and imported.
	it('refuses, never asks, when line 1 alone stops lines 2 and 3 being proof', () => {
		const result = parse(
			[
				'2026-06-01,12345678,CB A,-10.00',
				`2026-06-02,${IBAN_A},CB B,-20.00`,
				`2026-06-03,${IBAN_B},CB C,-30.00`
			].join('\n'),
			false
		);
		expect(result.invalidRows.map((row) => row.fact)).toStrictEqual([
			{ code: 'multi-account-file', column: 1 }
		]);
	});

	// Guards the other direction: a blank on line 1 over a constant column is the blank-cell rule's
	// « nothing to decide », as on a headed file, and the file imports whole.
	it('imports a file whose line 1 is blank over one account', () => {
		const result = parse(
			[
				'2026-06-01,,CB A,-10.00',
				`2026-06-02,${IBAN_B},CB B,-20.00`,
				`2026-06-03,${IBAN_B},CB C,-30.00`
			].join('\n'),
			false
		);
		expect({
			refusals: result.invalidRows.map((row) => row.fact.code),
			imported: result.transactions.length
		}).toStrictEqual({ refusals: [], imported: 3 });
	});
});
