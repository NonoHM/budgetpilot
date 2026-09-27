import type { DesignationRowFacts } from '$lib/domain/columnDesignation';
import {
	importFirstDataRow,
	importPreviewRows,
	importSampleCoverage,
	importSampleValues
} from './csv';
import { importColumnDateReadings, importColumnDateStates } from './columnDateState';
import type { ParsedCsvRow } from './types';

/**
 * Every per-row fact the designation screen draws, for ONE answer about line 1. THE ONE DEFINITION.
 *
 * A pure function of `(rows, hasHeaderRow)` and of nothing else, and the only way a route builds
 * these facts: each one below reads the same answer, so no fact can describe a file that starts on
 * a different line from its neighbours. The registry of what counts as a per-row fact is
 * `DESIGNATION_ROW_FACTS`, and the return type requires every member of it, so a fact added there
 * does not compile until it is computed here.
 *
 * ## Why the server computes both answers rather than the screen recomputing one
 *
 * The « Première ligne » switch is the user's answer, given in the browser after this payload has
 * left. Before #735 the screen repaired two fields itself (the row count and the preview) and left
 * the rest describing the file with line 1 skipped: the Date column's state, the row's first line,
 * the cards, their readings and the coverage. A headerless file whose only date proof was on line 1
 * was then asked how its dates read, showed a conversion the import did not write, and discarded the
 * answer. The column verdict needs the WHOLE column, which the browser does not hold, so the facts
 * for the other answer are computed here, by this same function, and ride the payload as
 * `otherHeaderRowFacts`. `readWithHeaderRow` swaps them in; it never recomputes one.
 *
 * @param rows The file's rows, line 1 included.
 * @param hasHeaderRow The answer about line 1 these facts describe.
 */
export function designationRowFacts(
	rows: ParsedCsvRow[],
	hasHeaderRow: boolean
): Required<DesignationRowFacts> {
	// Computed ONCE and shared with `dateReadings`: the two must describe the same cells, or a card
	// would print one value and convert another.
	const samples = importSampleValues(rows, 3, hasHeaderRow);
	const firstRow = importFirstDataRow(rows, hasHeaderRow);
	return {
		samples,
		firstRow,
		previewRows: importPreviewRows(rows, 5, hasHeaderRow),
		coverage: importSampleCoverage(rows, hasHeaderRow),
		// 7k: the whole-column verdict ships WITH the offer, one per column, so the screen never
		// holds a state the submit could contradict and never computes one itself.
		dateStates: importColumnDateStates(rows, hasHeaderRow),
		// Both readings of the SAME cells the row and the cards show.
		dateReadings: importColumnDateReadings(dateCellsPerColumn(firstRow, samples))
	};
}

/**
 * The designation payload's per-row half, as `/import` detects it: line 1 read as headers (the
 * only guess that route makes), the facts under that guess, and the facts under the other answer.
 *
 * The guess and the two fact sets leave together, from here, because they are one claim: the
 * top-level facts describe the file under `detectedHeaderRow`, and `otherHeaderRowFacts` under its
 * negation. A caller writing them separately could pair the wrong two.
 *
 * @param detected The facts under the guess, when the caller already holds them for another offer.
 */
export function designationFactsAsDetected(
	rows: ParsedCsvRow[],
	detected: Required<DesignationRowFacts> = designationRowFacts(rows, true)
) {
	return {
		...detected,
		otherHeaderRowFacts: designationRowFacts(rows, false),
		detectedHeaderRow: true as const
	};
}

/**
 * The cells whose two readings the screen needs, per column: the ROW's value first, then the CARD's.
 *
 * Index 0 is the first data row's cell, which is the value the Date row's line 2 prints and line 3
 * converts. Indices 1..n are `importSampleValues`'s own choices, which are what the picker's cards
 * print. They are DIFFERENT cells on a sparse column by design (`importSampleValues` picks the
 * first NON-EMPTY value per column, precisely so a sparse column does not render three blanks), so
 * converting the samples and printing them beside the row's value would show a conversion of a cell
 * the row never displayed.
 *
 * Built here rather than in the component so the raw value and its reading come from one array and
 * cannot drift apart.
 */
function dateCellsPerColumn(firstRow: string[], samples: string[][]): string[][] {
	return samples.map((values, column) => [firstRow[column] ?? '', ...values]);
}
