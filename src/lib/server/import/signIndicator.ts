import type { ParsedCsvRow } from './types';
import { parseAmountCents } from './utils/money';

/**
 * A closed vocabulary of direction tokens, matched case-insensitively against a WHOLE cell.
 *
 * Deliberately small, and it must stay small. Every entry widens what is refused, and a false
 * positive here refuses a statement that would have imported correctly, for a reason that does
 * not apply to it. These are the tokens real French and English exports carry. A bank writing
 * "sortie"/"entree" is not covered, and is not guessed at: see the docstring below for what that
 * costs and why paying it is the right way round.
 */
const DIRECTION_TOKENS = new Set(['d', 'c', 'db', 'cr', 'dr', 'debit', 'credit', 'w']);

/** The tokens that mean money out. The rest of `DIRECTION_TOKENS` means money in. */
const DEBIT_TOKENS = new Set(['d', 'db', 'dr', 'debit', 'w']);

export type SignIndicatorFinding = {
	column: string;
	// amount-sign-in-separate-column: no amount carries a sign, the column holds the direction (#320).
	// amount-sign-against-indicator: the amounts are signed AND the column holds a direction, and on some row the two
	// say opposite things (#1323). Two answers to one question, so the file is refused.
	code: 'amount-sign-in-separate-column' | 'amount-sign-against-indicator';
};

/**
 * Which column, if any, carries the direction that the amount column does not.
 *
 * ## The defect this exists for, measured
 *
 * A file shaped `date;libelle;montant;sens` with `24,90;D` rows imported with zero refusals and
 * every row typed as income: totalDebitCents 0, totalCreditCents 191489 on a three-row fixture
 * where 64,89 EUR was spending. Every money figure in the application was wrong and nothing said
 * so. It was refused before #309, by accident: `generic` refused any header outside a fixed list,
 * so `sens` produced an `unknown-column` refusal. Widening the profile to drop unrecognised
 * columns was right, and it removed the only thing refusing this shape. Asking what a widening
 * stops refusing is the question that found it.
 *
 * ## Three conditions, all required, and the conjunction is what keeps this narrow
 *
 * 1. Every parsable amount in the file is >= 0. One negative amount anywhere means the file signs
 *    its amounts, so an indicator column beside them is redundant rather than load-bearing, AS
 *    LONG AS IT AGREES. Where any row's sign contradicts its token (an unsigned amount marked
 *    debit, a negative one marked credit), the file proves two answers and is refused as
 *    `amount-sign-against-indicator` (#1323): letting the sign win stored that row reversed.
 * 2. Some other column's non-empty values are ALL drawn from `DIRECTION_TOKENS`.
 * 3. On an unsigned file, that column carries at least two DISTINCT tokens. A column reading "D" on every row carries
 *    no direction at all: it is a constant, and a statement of pure spending is ordinary. Without
 *    this, an all-expense export written with magnitudes and a constant marker would be refused
 *    when it is perfectly readable.
 *
 * ## What it cannot see, stated rather than left to be discovered
 *
 * A file with all-positive amounts and NO indicator column, or one whose indicator column uses a
 * vocabulary this set does not carry, is not refused HERE: nothing in the bytes separates it from a
 * real salary-only statement, and widening the vocabulary to chase it is how this starts refusing
 * files that would have imported correctly. Since #1207 (C2c-S1) such a file is no longer imported
 * as income in silence either: `amountSign.ts` finds no negative amount and the member is asked,
 * once, whether its rows are money out or money in. A file mixing both directions with an
 * unrecognised vocabulary still cannot be expressed by that file-wide answer (#1284).
 *
 * Returns the offending header and which of the two shapes it is, so the refusal can name both.
 */
export function detectSignIndicatorColumn(
	headers: string[],
	// The rows whose amounts are stored, from `datedAmountRows`, header excluded. Judged over every
	// row instead, one wrong-width line or undated footer put a non-token in the column and switched
	// the detector off for the whole file (#1323 pass, F2). On a headerless file line 1 is in here:
	// skipping it once hid the only « C » of a direction column (#1202's pass, finding 2).
	body: ParsedCsvRow[],
	amountColumn: string
): SignIndicatorFinding | null {
	const amountIndex = headers.indexOf(amountColumn);
	if (amountIndex === -1) return null;
	if (body.length === 0) return null;

	const amounts = body.map((row) => parseAmountCents(row.cells[amountIndex] ?? ''));
	const parsableAmounts = amounts.filter((cents) => cents !== null).length;
	// An absolute figure guarding the emptiness below. With no parsable amount at all, "every
	// amount is positive" is vacuously true, and refusing on it would refuse a file this function
	// has no evidence about.
	if (parsableAmounts === 0) return null;
	const signed = amounts.some((cents) => cents !== null && cents < 0);

	for (const [index, header] of headers.entries()) {
		if (index === amountIndex) continue;

		const distinctTokens = new Set<string>();
		let everyValueIsAToken = true;
		for (const [rowIndex, row] of body.entries()) {
			const cell = (row.cells[index] ?? '').trim().toLowerCase();
			// A row with no amount, or a zero one, carries no direction and is refused on its own
			// line: its cell must not switch the check off for the rows that are stored (pass 2, F-A).
			if (cell === '' || !amounts[rowIndex]) continue;
			if (!DIRECTION_TOKENS.has(cell)) {
				everyValueIsAToken = false;
				break;
			}
			distinctTokens.add(cell);
		}
		if (!everyValueIsAToken || distinctTokens.size === 0) continue;

		// Condition 3 is the UNSIGNED file's: a constant « D » beside magnitudes is a statement of
		// pure spending. In a signed file a constant column still contradicts any sign against it,
		// so it is judged below (#1323 pass, F1: a month with no credit imported « 24,90;D » as income).
		if (!signed) {
			if (distinctTokens.size >= 2)
				return { column: header, code: 'amount-sign-in-separate-column' };
			continue;
		}

		// A signed file: the column is redundant only while it agrees with every sign. A zero, an
		// unparsable amount or an empty cell says nothing either way.
		const disagrees = body.some((row, rowIndex) => {
			const cents = amounts[rowIndex];
			const cell = (row.cells[index] ?? '').trim().toLowerCase();
			if (cents === null || cents === 0 || cell === '') return false;
			return cents < 0 !== DEBIT_TOKENS.has(cell);
		});
		if (disagrees) return { column: header, code: 'amount-sign-against-indicator' };
	}

	return null;
}
