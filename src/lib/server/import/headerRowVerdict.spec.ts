import { describe, expect, it } from 'vitest';
import { designationFactsAsDetected } from './designationFacts';
import { headerRowVerdict } from './headerRowVerdict';
import type { ParsedCsvRow } from './types';
import { parseRows } from './utils/csv';

/**
 * #1217, #797: `/import` read line 1 as headers whatever it held, so a statement with no header row
 * opened the designation screen one transaction short, with dates for column names. Measured over
 * the synthetic corpus: 0 of 34 files whose line 1 is a transaction were read that way
 * (`docs/superpowers/2026-11-05-1217/`, kept outside the repository).
 *
 * The verdict is Python's `csv.Sniffer.has_header` vote, narrowed to DATE columns: a column whose
 * every later cell reads as a date votes on whether line 1 does too. Amount columns do not vote,
 * because a header such as « 2026 » parses as an amount and never as a date.
 */

const rows = (text: string): ParsedCsvRow[] => parseRows(text);

describe('headerRowVerdict', () => {
	it('proves a header when line 1 holds a name where every later line holds a date', () => {
		expect(
			headerRowVerdict(rows('Date,Libelle,Montant\n2026-06-01,CB A,-10.00\n2026-06-02,CB B,-20.00'))
		).toStrictEqual({ kind: 'resolved', hasHeaderRow: true });
	});

	it('proves data when line 1 holds a date where every later line does', () => {
		expect(
			headerRowVerdict(
				rows('2026-06-01,CB A,-10.00\n2026-06-02,CB B,-20.00\n2026-06-03,CB C,-5.00')
			)
		).toStrictEqual({ kind: 'resolved', hasHeaderRow: false });
	});

	it('counts a date that reads both ways as a date', () => {
		expect(
			headerRowVerdict(
				rows('01/06/2026;CB A;-10,00\n02/06/2026;CB B;-20,00\n03/06/2026;CB C;-5,00')
			)
		).toStrictEqual({ kind: 'resolved', hasHeaderRow: false });
	});

	// The amount column must not vote: « 2026 » parses as an amount, so a vote there would call a
	// header line data, and the column names would be imported as a transaction.
	it('ignores an amount column whose header parses as a number', () => {
		expect(
			headerRowVerdict(rows('Date,Libelle,2026\n2026-06-01,CB A,-10.00\n2026-06-02,CB B,-20.00'))
		).toStrictEqual({ kind: 'resolved', hasHeaderRow: true });
	});

	// A header with a digit in it is still a name: exports with two date columns head them « Date 1 »
	// and « Date 2 ». Only a cell that READS as a date votes for data.
	it('proves a header when the date columns are headed with numbered names', () => {
		expect(
			headerRowVerdict(
				rows(
					'Date 1,Date 2,Libelle,Montant\n2026-06-01,2026-06-02,CB A,-10.00\n2026-06-03,2026-06-04,CB B,-20.00'
				)
			)
		).toStrictEqual({ kind: 'resolved', hasHeaderRow: true });
	});

	it('reports the two cells when line 1 reads as a date in one date column and not in another', () => {
		expect(
			headerRowVerdict(
				rows(
					'2026-06-01,Valeur,CB A,-10.00\n2026-06-02,2026-06-02,CB B,-20.00\n2026-06-03,2026-06-03,CB C,-5.00'
				)
			)
		).toStrictEqual({ kind: 'contradictory', dateColumn: 0, otherColumn: 1 });
	});

	it('has nothing to decide when no column holds dates on every later line', () => {
		expect(headerRowVerdict(rows('a,b\nc,d\ne,f'))).toStrictEqual({ kind: 'nothing-to-decide' });
	});

	it('has nothing to decide when line 1 is blank in every date column', () => {
		expect(
			headerRowVerdict(rows(',CB A,-10.00\n2026-06-02,CB B,-20.00\n2026-06-03,CB C,-5.00'))
		).toStrictEqual({ kind: 'nothing-to-decide' });
	});
});

describe('designationFactsAsDetected: the guess, the facts and the count leave together', () => {
	const HEADERLESS = '2026-06-01,CB A,-10.00\n2026-06-02,CB B,-20.00\n2026-06-03,CB C,-5.00';
	const detect = (text: string) => {
		const parsed = rows(text);
		const verdict = headerRowVerdict(parsed);
		if (verdict.kind === 'contradictory') throw new Error('fixture is contradictory');
		// 2: the count the parse gives under « line 1 is headers », which is what every route holds.
		return designationFactsAsDetected(parsed, 2, verdict);
	};

	it('opens a headerless file read as data, with line 1 counted and shown', () => {
		const facts = detect(HEADERLESS);

		expect(facts.detectedHeaderRow).toBe(false);
		expect(facts.rowCount).toBe(3);
		expect(facts.firstRow).toStrictEqual(['2026-06-01', 'CB A', '-10.00']);
		// The other answer's facts ride along, so the switch still has something true to show.
		expect(facts.otherHeaderRowFacts.firstRow).toStrictEqual(['2026-06-02', 'CB B', '-20.00']);
	});

	it('opens a file with a header row exactly as before', () => {
		const facts = detect('Date,Libelle,Montant\n2026-06-01,CB A,-10.00\n2026-06-02,CB B,-20.00');

		expect(facts.detectedHeaderRow).toBe(true);
		expect(facts.rowCount).toBe(2);
		expect(facts.firstRow).toStrictEqual(['2026-06-01', 'CB A', '-10.00']);
	});
});
