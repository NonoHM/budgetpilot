import { describe, expect, it } from 'vitest';
import { currencyCodeColumns, readCurrencyAnswer } from './headerlessCurrency';
import { columnProposals } from './columnProposals';
import type { ParsedCsvRow } from './types';

function rowsOf(...lines: string[][]): ParsedCsvRow[] {
	return lines.map((cells, index) => ({ cells, lineNumber: index + 1 }) as unknown as ParsedCsvRow);
}

describe('currencyCodeColumns (#1213)', () => {
	it('finds a column whose every non-blank cell is a code, line 1 included', () => {
		const rows = rowsOf(
			['2026-06-01', 'A', '-1', 'USD'],
			['2026-06-02', 'B', '-2', ''],
			['2026-06-03', 'C', '-3', '€']
		);
		expect(currencyCodeColumns(rows)).toEqual([3]);
	});

	it('does not read lowercase words that spell codes, nor unknown capitals, nor a blank column', () => {
		const rows = rowsOf(['all', 'TTC', '', 'USD'], ['top', 'TTC', '', 'n/a']);
		expect(currencyCodeColumns(rows)).toEqual([]);
	});
});

describe('columnProposals, currency (#1213)', () => {
	const rows = rowsOf(['2026-06-01', 'A', '-1.00', 'EUR'], ['2026-06-02', 'B', '-2.00', 'EUR']);

	it('designates the one column of codes when line 1 is data', () => {
		expect(columnProposals(rows, false).designated.currency).toBe(3);
	});

	it('proposes no currency when line 1 is headers, which declare it by name', () => {
		expect(columnProposals(rows, true).candidates.currency).toEqual([]);
	});

	it('designates neither of two columns of codes, and proposes both', () => {
		const two = rowsOf(
			['2026-06-01', 'A', '-1.00', 'USD', 'EUR'],
			['2026-06-02', 'B', '-2.00', 'USD', 'EUR']
		);
		const proposals = columnProposals(two, false);
		expect(proposals.designated.currency).toBeNull();
		expect(proposals.candidates.currency).toEqual([3, 4]);
	});
});

describe('readCurrencyAnswer (#1213)', () => {
	const mapping = { dateIndex: 0, labelIndex: 1, amountIndex: 2, categoryIndex: 4, columnCount: 6 };
	it.each([
		[null, { kind: 'absent' }],
		['', { kind: 'absent' }],
		['none', { kind: 'declined' }],
		['3', { kind: 'designated', index: 3 }],
		['5', { kind: 'designated', index: 5 }],
		['6', { kind: 'invalid' }],
		['4', { kind: 'invalid' }],
		['0', { kind: 'invalid' }],
		[' 3', { kind: 'invalid' }],
		['NONE', { kind: 'invalid' }]
	])('%j reads as %j', (raw, expected) => {
		expect(readCurrencyAnswer(raw, mapping)).toEqual(expected);
	});
});
