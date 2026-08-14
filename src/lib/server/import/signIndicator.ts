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
 *    its amounts, so an indicator column beside them is redundant rather than load-bearing. The
 *    sign wins and nothing is refused.
 * 2. Some other column's non-empty values are ALL drawn from `DIRECTION_TOKENS`.
 * 3. That column carries at least two DISTINCT tokens. A column reading "D" on every row carries
 *    no direction at all: it is a constant, and a statement of pure spending is ordinary. Without
 *    this, an all-expense export written with magnitudes and a constant marker would be refused
 *    when it is perfectly readable.
 *
 * ## What it cannot see, stated rather than left to be discovered
 *
 * A file with all-positive amounts and NO indicator column is a statement of pure income as far
 * as anything here can tell, and it imports as one. So does a file whose indicator column uses a
 * vocabulary this set does not carry. Both are still wrong for the user, and neither is
 * detectable: there is nothing in the bytes to separate them from a real salary-only statement.
 * Widening the vocabulary to chase them is how this starts refusing files that would have
 * imported correctly, which is the worse direction. The column mapping path closes this properly
 * by letting the user say what the column means.
 *
 * Returns the offending header so the refusal can name it.
 */
export function detectSignIndicatorColumn(
	headers: string[],
	rows: ParsedCsvRow[],
	amountColumn: string
): string | null {
	const amountIndex = headers.indexOf(amountColumn);
	if (amountIndex === -1) return null;

	const body = rows.slice(1);
	if (body.length === 0) return null;

	let parsableAmounts = 0;
	for (const row of body) {
		const cents = parseAmountCents(row.cells[amountIndex] ?? '');
		if (cents === null) continue;
		parsableAmounts += 1;
		if (cents < 0) return null;
	}
	// An absolute figure guarding the emptiness above. With no parsable amount at all, "every
	// amount is positive" is vacuously true, and refusing on it would refuse a file this function
	// has no evidence about.
	if (parsableAmounts === 0) return null;

	for (const [index, header] of headers.entries()) {
		if (index === amountIndex) continue;

		const distinctTokens = new Set<string>();
		let everyValueIsAToken = true;
		for (const row of body) {
			const cell = (row.cells[index] ?? '').trim().toLowerCase();
			if (cell === '') continue;
			if (!DIRECTION_TOKENS.has(cell)) {
				everyValueIsAToken = false;
				break;
			}
			distinctTokens.add(cell);
		}

		if (everyValueIsAToken && distinctTokens.size >= 2) return header;
	}

	return null;
}
