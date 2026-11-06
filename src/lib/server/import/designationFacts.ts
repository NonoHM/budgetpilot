import { EMPTY_ASSIGNMENT, type DesignationRowFacts } from '$lib/domain/columnDesignation';
import {
	importFirstDataRow,
	importPreviewRows,
	importSampleCoverage,
	importSampleValues
} from './csv';
import {
	importColumnCells,
	importColumnDateReadings,
	importColumnDateStates
} from './columnDateState';
import { amountSignVerdict } from './amountSign';
import type { AmountSignState } from '$lib/domain/columnDesignation';
import { columnProposals } from './columnProposals';
import type { HeaderRowVerdict } from './headerRowVerdict';
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
		dateReadings: importColumnDateReadings(dateCellsPerColumn(firstRow, samples)),
		proposals: columnProposals(rows, hasHeaderRow),
		amountSignStates: importColumnCells(rows, hasHeaderRow).map(amountSignState)
	};
}

/**
 * The designation payload's per-row half, as `/import` detects it: the answer about line 1 the file
 * shows (`headerRowVerdict`, #1217), the facts under that answer, the facts under the other answer,
 * and the row count under it.
 *
 * The four leave together, from here, because they are one claim: the top-level facts describe the
 * file under `detectedHeaderRow`, `otherHeaderRowFacts` under its negation, and `rowCount` counts the
 * lines the top-level facts read. A caller writing them separately could pair the wrong two, which
 * is the defect #735 closed: the header-reading facts under a « données » guess.
 *
 * `contradictory` is excluded by type: the caller refuses that file before building any offer.
 * `nothing-to-decide` keeps the header reading, the answer every comparable defaults to.
 *
 * @param headerReadingRowCount The parse's count with line 1 as headers, which every route holds.
 * @param headerFacts The facts with line 1 as headers, when the caller already holds them.
 */
export function designationFactsAsDetected(
	rows: ParsedCsvRow[],
	headerReadingRowCount: number,
	verdict: Exclude<HeaderRowVerdict, { kind: 'contradictory' }>,
	headerFacts: Required<DesignationRowFacts> = designationRowFacts(rows, true)
) {
	const detectedHeaderRow = verdict.kind === 'resolved' ? verdict.hasHeaderRow : true;
	const dataFacts = designationRowFacts(rows, false);
	return {
		...(detectedHeaderRow ? headerFacts : dataFacts),
		otherHeaderRowFacts: detectedHeaderRow ? dataFacts : headerFacts,
		detectedHeaderRow,
		rowCount: Math.max(0, headerReadingRowCount + (detectedHeaderRow ? 0 : 1))
	};
}

/**
 * The same payload for an offer produced by a REMEMBERED mapping (recognised, partial, lost, or a
 * correction): line 1 as headers, detection's designations withdrawn, candidates kept.
 *
 * Headers without consulting the file, because the member's past answer is layer 1 of the import
 * onion and the file's own evidence is layer 2 (#1203): a mapping is saved only under a header row
 * (`/import/columns`) and is found by line 1's fingerprint. Detection must not seed different
 * columns either, which one press would save over the member's own (#352). Actual Budget orders it
 * the same way, the saved `csv-mappings` before any guess (#352, research.md).
 */
export function designationFactsAsRemembered(
	rows: ParsedCsvRow[],
	headerReadingRowCount: number,
	headerFacts?: Required<DesignationRowFacts>
) {
	return withoutDesignations(
		designationFactsAsDetected(
			rows,
			headerReadingRowCount,
			{ kind: 'resolved', hasHeaderRow: true },
			headerFacts
		)
	);
}

/** The same facts with detection's designations withdrawn, candidates kept. */
export function withoutDesignations<T extends ReturnType<typeof designationFactsAsDetected>>(
	facts: T
): T {
	return { ...facts, proposals: { ...facts.proposals, designated: EMPTY_ASSIGNMENT } };
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

/** One column's sign state for the screen, through the parser's own verdict function. */
function amountSignState(cells: string[]): AmountSignState {
	const verdict = amountSignVerdict(cells);
	return verdict.kind === 'resolved'
		? 'signed'
		: verdict.kind === 'ambiguous'
			? 'unsigned'
			: 'none';
}
