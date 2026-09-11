import { describe, expect, it } from 'vitest';
import { parseCsvTransactionRows } from './csv';
import { parseRows } from './utils/csv';
import { refusedForBounds } from './refusals';
import { CSV_DEFAULT_MAX_COLUMNS } from './columnBounds';
import { CSV_MAX_ROWS } from './csv';

/**
 * WHY A FILE PRODUCED NO TRANSACTIONS decides whether it is worth explaining further.
 *
 * `detectSplitAmountPair` exists to turn "no valid transactions" into a refusal that NAMES the two
 * money columns (#343), because a file whose money sits in two columns cannot be repaired by
 * designating one of them. That reason holds for a file the parser found unreadable. It does not
 * hold for a file the parser refused on its DIMENSIONS: a nicer sentence cannot change that
 * outcome, so the work has no reachable purpose, and it is exactly the oversized file on which the
 * work is most expensive.
 *
 * Each case below separates "this refusal is structural, so stop" from "this refusal is about the
 * contents, so it is still worth naming the columns".
 */
describe('refusedForBounds', () => {
	function parse(csv: string) {
		return parseCsvTransactionRows(parseRows(csv), {});
	}

	function wide(columns: number, rows: number) {
		return Array.from({ length: columns }, () => 'a').join(',') + '\n' + 'x\n'.repeat(rows);
	}

	it('is true when the file was refused for too many columns', () => {
		const result = parse(wide(CSV_DEFAULT_MAX_COLUMNS + 1, 3));
		expect(result.transactions).toHaveLength(0);
		expect(refusedForBounds(result)).toBe(true);
	});

	it('is true when the file was refused for too many rows', () => {
		const result = parse(wide(4, CSV_MAX_ROWS + 1));
		expect(result.transactions).toHaveLength(0);
		expect(refusedForBounds(result)).toBe(true);
	});

	// The control, and the reason this is a predicate rather than "skip the detector when there are
	// zero transactions": the split-amount file produces zero transactions too, and it MUST still
	// reach the detector or #343 regresses.
	it('is false for a file that is simply unreadable, which is the case the detector is for', () => {
		const result = parse('Date,Libelle,Debit,Credit\nnot-a-date,A,-10,\n');
		expect(result.transactions).toHaveLength(0);
		expect(refusedForBounds(result)).toBe(false);
	});

	it('is false for a file that imported cleanly', () => {
		const result = parse('date;label;amount\n2026-01-15;Coffee;-12,30\n');
		expect(result.transactions.length).toBeGreaterThan(0);
		expect(refusedForBounds(result)).toBe(false);
	});
});
