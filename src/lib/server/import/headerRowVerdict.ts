import type { FileVerdict } from '$lib/domain/fileVerdict';
import { importColumnCells } from './columnDateState';
import type { ParsedCsvRow } from './types';
import { isDateCellUnderEitherReading, normalizeParsedRows } from './utils/csv';

/**
 * Whether line 1 is a header row, as the file shows it (#1217, #797).
 *
 * `contradictory` carries the two columns whose line-1 cells disagree: `dateColumn` reads as a date,
 * `otherColumn` does not, and both are date columns on every later line.
 */
export type HeaderRowVerdict = FileVerdict<
	{ hasHeaderRow: boolean },
	{ dateColumn: number; otherColumn: number },
	never
>;

/**
 * Python's `csv.Sniffer.has_header` vote, narrowed to DATE columns (cpython@aaaf61c, Lib/csv.py
 * L635-L696). A date column is one whose every non-blank cell after line 1 reads as a date in the
 * app's grammar; each votes on whether line 1's cell does too. Amount columns do not vote: a header
 * such as « 2026 » parses as an amount, and no header parses as a date.
 *
 * Sniffer answers « no header » when nothing votes; this answers `nothing-to-decide`, and the caller
 * keeps the header reading every comparable defaults to (Actual Budget's `hasHeaderRow`). A file
 * whose dates the grammar cannot read (`01/06/26`) has no date column here, so it stays a header
 * file, as before.
 *
 * Pure function of the rows, like every other designation fact.
 */
export function headerRowVerdict(rows: ParsedCsvRow[]): HeaderRowVerdict {
	const lineOne = normalizeParsedRows(rows.slice(0, 1))[0]?.cells ?? [];
	const voting = importColumnCells(rows, true).flatMap((cells, column) => {
		const later = cells.filter((cell) => cell.trim() !== '');
		const isDateColumn = later.length > 0 && later.every(isDateCellUnderEitherReading);
		return isDateColumn && (lineOne[column] ?? '').trim() !== '' ? [column] : [];
	});
	const reads = voting.filter((column) => isDateCellUnderEitherReading(lineOne[column]));
	const fails = voting.filter((column) => !isDateCellUnderEitherReading(lineOne[column]));

	if (reads.length > 0 && fails.length > 0)
		return { kind: 'contradictory', dateColumn: reads[0], otherColumn: fails[0] };
	if (reads.length > 0) return { kind: 'resolved', hasHeaderRow: false };
	if (fails.length > 0) return { kind: 'resolved', hasHeaderRow: true };
	return { kind: 'nothing-to-decide' };
}
