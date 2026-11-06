import type { FileVerdict } from '$lib/domain/fileVerdict';
import { parseAmountCents } from './utils/money';

export { AMOUNT_SIGNS, readAmountSignAnswer } from '$lib/domain/amountSign';
export type { AmountSign } from '$lib/domain/amountSign';

/**
 * Does the amount column say which rows are money out? (#1207 C2c-S1, decision record #1206.)
 *
 * - `resolved`: one cell parses below zero, so the file signs its amounts. That proves the column
 *   is signed, not which sign means money out (#1283); the parser reads minus as out, as before.
 * - `ambiguous`: every parsed cell is zero or above and one is above. The file exhibits the question
 *   and proves nothing, so the member is asked (AGENTS.md, the four outcomes). `sample` is the first
 *   such cell, for the refusal sentence.
 * - `nothing-to-decide`: no cell parses, or every one is zero: no row would be written either way.
 *
 * No `contradictory`: a column cannot prove both directions at once.
 *
 * RANGES OVER WHAT THE CALLER HANDS IT, and the two callers hand different sets on purpose. The
 * parser (`resolvedRows.ts`) passes the rows that carry a dated amount, so a negative footer cannot
 * make an unsigned file look signed; the screen (`designationFacts.ts`) passes the whole column. The
 * parser's set is a subset, so the only disagreement is the parser asking where the screen read
 * `signed`, and `/import/columns` reopens the step from that refusal (`askAmountSign`).
 */
export type AmountSignVerdict = FileVerdict<object, never, { sample: string }>;

export function amountSignVerdict(cells: readonly string[]): AmountSignVerdict {
	let sample: string | null = null;
	for (const cell of cells) {
		const cents = parseAmountCents(cell);
		if (cents === null) continue;
		if (cents < 0) return { kind: 'resolved' };
		if (cents > 0 && sample === null) sample = cell;
	}
	return sample === null ? { kind: 'nothing-to-decide' } : { kind: 'ambiguous', sample };
}
