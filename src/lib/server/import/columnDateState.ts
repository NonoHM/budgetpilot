import { detectDateOrder } from './dateOrder';
import {
	firstDataRowIndex,
	isDateCellUnderEitherReading,
	normalizeParsedRows,
	readDateCell
} from './utils/csv';
import type { ParsedCsvRow } from './types';

/**
 * What one column of a file says about itself as a date column, for the designation screen.
 *
 * ## SEVEN VALUES, and the seventh is the reason this type exists
 *
 * `DateOrderVerdict` has four, and they cannot produce these seven, because `nothing-to-decide`
 * covers three states that the screen must render as three different sentences. Measured, one
 * column each: an ISO column, a column of `CARD_PAYMENT`, and a column blank on every row all
 * return `nothing-to-decide`, since none of them carries a cell of the ambiguous grammar.
 *
 * So the state is a function of the verdict AND a second parser fact, « does any cell parse as a
 * date », which `isDateCellUnderEitherReading` answers. Folding the ISO case into `proven-day`
 * instead would keep six values and make this type assert a day/month reading for a column that
 * has no day/month reading, which is a transmitted fact that looks right and is not.
 *
 * ## THIS ENUM IS INTERNAL, and that sentence is what keeps adding a value cheap
 *
 * Server to client, one deployment, one artefact. Adding a value is therefore NOT breaking: there
 * is no version boundary at which an older client holds an exhaustive switch and meets a value it
 * does not know, and the catalogue's own dispatch has no default arm, so a value added without a
 * message fails to compile rather than rendering blank.
 *
 * **If a public REST API ever exposes import state, this value set becomes a contract and adding
 * to it becomes breaking.** That is the one thing in this work that could force a major version,
 * and it is prevented by this paragraph rather than by a migration later. Anyone exposing these
 * values outside the process owes a mapping to a published set, not a re-export of this one.
 *
 * ## It carries NO DATA FROM THE FILE, deliberately
 *
 * Seven constants and nothing else. `DateOrderVerdict` carries evidence cells because a refusal
 * has to name the value it came from; this does not, because the screen already holds the column's
 * own sample values and renders the pair from them. A state that carried its own evidence would
 * put a second, unbounded copy of a user's cell into the designation payload, where the first copy
 * is already bounded and sanitised. One fewer place for a file's contents to reach a page.
 */
export type ColumnDateState =
	/** A cell placed a component above 12 FIRST, so the column proves day-first. */
	| 'proven-day'
	/** A cell placed a component above 12 SECOND, so the column proves month-first. */
	| 'proven-month'
	/** The format settles the order, so there is nothing to ask. ISO today. See #631. */
	| 'proven-shape'
	/** Every cell reads both ways. THE ONLY STATE THAT ASKS THE USER ANYTHING. */
	| 'ambiguous'
	/** One column proved BOTH orders, so no answer would be right. */
	| 'inconsistent'
	/** Cells, but none of them a date under either reading. */
	| 'no-dates'
	/** Blank on every row. */
	| 'empty';

/**
 * One column's cells to its state. THE ONE MAPPING, not a switch repeated at call sites.
 *
 * Reads the WHOLE column, never the preview. Three ambiguous values in a file whose fortieth row
 * reads `24/06/2026` would otherwise ask a question the file has already answered, which is 7a's
 * stated reason for the rule and is pinned as a test.
 *
 * The order test is `detectDateOrder` itself rather than a second implementation of the rule, so
 * the screen and the parser cannot disagree about what an ambiguous column is.
 *
 * @param values The cells of ONE column, in file order, excluding the header row. Pure: no clock,
 *   no locale, no ambient state, so a stored state is recomputable from the same cells.
 */
export function columnDateState(values: readonly string[]): ColumnDateState {
	const verdict = detectDateOrder(values);

	if (verdict.kind === 'contradictory') return 'inconsistent';
	if (verdict.kind === 'ambiguous') return 'ambiguous';
	if (verdict.kind === 'resolved')
		return verdict.order === 'day-first' ? 'proven-day' : 'proven-month';

	// `nothing-to-decide`, which is the branch the four verdicts cannot resolve on their own.
	if (values.some((value) => isDateCellUnderEitherReading(value))) return 'proven-shape';
	return values.some((value) => value.trim() !== '') ? 'no-dates' : 'empty';
}

/**
 * One state per column of the file, in file order, for the designation offer.
 *
 * ## Computed where the preview is built, which is 7k's whole ruling
 *
 * The screen holds the fact BEFORE the user gestures, so there is no pending state inside an
 * 18 px line whose row height is invariant, and no second implementation of the rule on the
 * client. The designation screen becomes a reader of parser facts, never a computer of them.
 *
 * ## For every column, including the ones nobody will designate
 *
 * That is deliberate and it is what lets the screen tell 7a's `inconsistent` from a column that
 * simply has no dates, on the row the user is about to change, before anything is submitted. The
 * cost is linear in cells and is bounded twice over by guards that already exist: the 256,000
 * byte cap in `file.ts`, and `exceedsCsvResourceCeiling` at 5,120 columns or 5,120,000 cells,
 * enforced in `readImportFile` where every door passes. Worst reachable cost measured 2026-09-16
 * at 31.8 ms, against 22.1 ms for `importSampleCoverage`, which already walks the same matrix on
 * the same path. No ADDITIONAL sampling cap is taken, per 7k and #630: a capped scan would
 * contradict the whole-column ruling that makes the verdict worth having.
 *
 * ## Indexed by column, because the screen designates by index
 *
 * Normalised through the same `normalizeParsedRows` as the header cells and the samples, so the
 * state under a card describes the column that card shows. A different normalisation here would
 * let someone designate a column whose state was computed from different bytes.
 *
 * @param rows The file's rows, header included.
 * @param hasHeaderRow False when line 1 is a transaction. Honoured for the same reason the row
 *   loop honours it: a headerless file's first line is data, and skipping it drops one cell of
 *   evidence from every such file.
 */
export function importColumnDateStates(
	rows: ParsedCsvRow[],
	hasHeaderRow?: boolean
): ColumnDateState[] {
	const normalized = normalizeParsedRows(rows);
	if (normalized.length === 0) return [];

	const width = normalized[0].cells.length;
	const columns: string[][] = Array.from({ length: width }, () => []);

	// A cell a short row never had is skipped rather than pushed as an empty string: a ragged file
	// is ordinary, and counting absent cells as blanks would report a populated column as `empty`
	// whenever enough rows are short.
	for (let row = firstDataRowIndex(hasHeaderRow); row < normalized.length; row++) {
		const cells = normalized[row].cells;
		for (let column = 0; column < width; column++) {
			const cell = cells[column];
			if (cell !== undefined) columns[column].push(cell);
		}
	}

	return columns.map((values) => columnDateState(values));
}

/** One column's sample cells, each read under both orders. `null` is "not a date that way". */
export interface ColumnDateReadings {
	dayFirst: (string | null)[];
	monthFirst: (string | null)[];
}

/**
 * Both readings of each sample value, computed where the parse is.
 *
 * ## Why the server does this and not the browser
 *
 * The picker's two cards show the user their OWN cell read both ways, and the row's line 3 shows
 * the one reading in force. Converting a cell to a date is `normalizeDate` composed with
 * `isValidIsoDate`, and doing that in the browser would be a second implementation of the rule in
 * another language, drifting from the parser the first time either changes. So the server sends
 * ISO values and the browser only FORMATS them, which is a locale concern and genuinely belongs
 * there.
 *
 * ## It reads the samples, not the file
 *
 * Takes the values `importSampleValues` already chose rather than walking the rows again. Those are
 * the three the cards show, so the pairs cannot disagree with the values beside them, and no new
 * cell content enters the payload: the raw side is already there.
 *
 * @param samples One array of sample cells per column, in file order.
 */
export function importColumnDateReadings(samples: readonly string[][]): ColumnDateReadings[] {
	return samples.map((values) => ({
		dayFirst: values.map((value) => readDateCell(value, 'day-first')),
		monthFirst: values.map((value) => readDateCell(value, 'month-first'))
	}));
}
