import { detectDateOrder } from './dateOrder';
import { isDateCellUnderEitherReading } from './utils/csv';

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

	if (verdict.kind === 'mixed') return 'inconsistent';
	if (verdict.kind === 'ambiguous') return 'ambiguous';
	if (verdict.kind === 'resolved')
		return verdict.order === 'day-first' ? 'proven-day' : 'proven-month';

	// `nothing-to-decide`, which is the branch the four verdicts cannot resolve on their own.
	if (values.some((value) => isDateCellUnderEitherReading(value))) return 'proven-shape';
	return values.some((value) => value.trim() !== '') ? 'no-dates' : 'empty';
}
