import { designationReach, type CsvRefusalCode, type CsvRefusalFact } from './refusals';
import { refusedForBounds } from './refusals';
import { detectSplitAmountPair, PROFILE_READS_AMOUNT_PAIR } from './splitAmount';
import type {
	AccountColumnFact,
	DateOrderFact,
	MultiAccountFact,
	SplitFact
} from './offerPrecedence';
import type { CsvImportResult, ParsedCsvRow } from './types';

/**
 * THE FACTS A DOOR HANDS `resolveImportOffer`, each computed by one definition here rather than by
 * a predicate each route writes for itself. `offerPrecedence.ts` decides the ORDER between them;
 * this module decides what each one IS.
 */

/**
 * « CAN A DESIGNATION HELP THIS FILE? », the one answer both doors into the screen read (#351).
 *
 * - The UPLOAD door asks after a parse that produced nothing, and hands every refusal it met.
 * - The CORRECTION door asks BEFORE any parse, deliberately (a parse would read the file through the
 *   correspondance the user has just said is wrong), and hands only `fileDimensionRefusal`'s fact,
 *   the one refusal no mapping decides. Its `columnsDisowned` is the user's own statement that the
 *   columns are wrong, which is the repairable fact the upload door has to find in its refusals.
 *
 * The clauses, in the order they decide:
 * 1. No header cell: nothing to designate.
 * 2. A `dimensions` refusal (`DESIGNATION_REACH`): no arrangement of columns changes a file's size
 *    or makes a data row appear (#628, and #351's header-only file).
 * 3. A profile that reads its amounts from a pair (`PROFILE_READS_AMOUNT_PAIR`): the screen's one
 *    amount role cannot express it, and `/import/columns` would refuse the pair after the work.
 * 4. The user disowned the columns, or at least ONE refusal is `repairable`. `some` rather than
 *    `every`: a file where one row failed on an unusable currency and the rest on their dates is
 *    still a file naming a column might rescue.
 *
 * ## What this used to be, and what it cost
 *
 * `offersDesignation` on `/import` required a `missing-required-column` refusal once, so it fired
 * only for a file NOTHING recognised. A blind usability session met a file whose headers matched
 * and whose `01.06.2026` dates then failed on all 25 rows; the rescue was routed away from it and
 * the tester hand-edited the statement. It was then widened to « nothing imported, minus a private
 * cannot-repair list », which disagreed with the bound list beside it (#628) and was consulted by
 * one of the two doors only (#351).
 */
export function designationCanHelp(file: {
	headerCells: readonly string[];
	refusals: readonly { code: CsvRefusalCode }[];
	columnsDisowned: boolean;
	amountPairRead?: boolean;
}): boolean {
	if (file.headerCells.length === 0) return false;
	if (file.refusals.some((fact) => designationReach(fact.code) === 'dimensions')) return false;
	if (file.amountPairRead) return false;
	return (
		file.columnsDisowned ||
		file.refusals.some((fact) => designationReach(fact.code) === 'repairable')
	);
}

/**
 * The split-amount refusal (#343), for a parse that produced nothing, or null.
 *
 * Null on a parse that produced rows, on a file refused on its dimensions (the pair walk is the
 * expensive work and cannot change that outcome, #604), and on a file whose profile READ the pair
 * (#712): there the parse is empty for another reason, and « the money is split across two columns
 * nobody reads » is false.
 */
export function splitAmountFact(
	result: CsvImportResult,
	headerCells: string[],
	rows: ParsedCsvRow[]
): SplitFact | null {
	if (result.transactions.length > 0) return null;
	if (refusedForBounds(result)) return null;
	if (PROFILE_READS_AMOUNT_PAIR[result.summary.profile]) return null;
	const pair = detectSplitAmountPair(headerCells, rows);
	return pair
		? {
				code: 'amount-split-across-columns',
				columns: pair.map((name) => `« ${name} »`).join(' et ')
			}
		: null;
}

/**
 * The facts an EMPTY parse raised, as the typed offers `resolveImportOffer` takes.
 *
 * ONE definition of the predicates both routes used to write inline (`/import` and
 * `/import/columns` each tested `invalidRows.length === 1` and a code). They rest on one property
 * of `csv.ts`: it returns exactly ONE fact per `emptyResult`, so `multiAccount`, `accountColumn`
 * and `dateOrder` never arrive together and their mutual order is `csv.ts`'s. #717 records moving
 * that order into the ladder; this function is the one place that change would land.
 *
 * `header` is the first header-scoped refusal, which only `/import/columns` surfaces
 * (`offerPrecedence.ts`'s docstring says why the auto path does not).
 */
export function emptyParseFacts(result: CsvImportResult): {
	header: CsvRefusalFact | null;
	multiAccount: MultiAccountFact | null;
	accountColumn: AccountColumnFact | null;
	dateOrder: DateOrderFact | null;
} {
	const empty = result.transactions.length === 0;
	const only = empty && result.invalidRows.length === 1 ? result.invalidRows[0].fact : null;
	return {
		header: empty
			? (result.invalidRows.find((refusal) => refusal.scope.kind === 'header')?.fact ?? null)
			: null,
		multiAccount: only?.code === 'multi-account-file' ? only : null,
		accountColumn: only?.code === 'ambiguous-account-column' ? only : null,
		dateOrder: only?.code === 'ambiguous-date-order' ? only : null
	};
}
