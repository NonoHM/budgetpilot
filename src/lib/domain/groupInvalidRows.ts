import type { ImportInvalidRowDetail } from './importSummary';

/**
 * The rejected rows, folded onto the reason they were rejected for.
 *
 * ## Why this exists
 *
 * A blind usability session met twenty-five table rows carrying one sentence twenty-five times.
 * Every row was true and the table as a whole said nothing the first row had not: the reason was
 * identical, the field was identical, and only the value in the preview differed. Twenty-five
 * lines of that is the least useful thing on the screen, and it pushes the one action that could
 * help — the offer to designate the columns — off the fold.
 *
 * One line with a count, and the lines behind a reveal, is the same information.
 *
 * ## Keyed on the whole reason MINUS the part that varies per row
 *
 * Neither "the code" nor "the rendered sentence" is the right key, and both were tried:
 *
 * - **The code alone** merges `Colonne non autorisée: alpha` with `Colonne non autorisée: beta`.
 *   Two structurally different complaints become one row whose heading names `alpha`, and `beta`
 *   is not on the screen at all. That is a table that has lost information rather than folded it.
 * - **The rendered sentence** puts twenty-five dates into twenty-five groups, because the
 *   sentence now carries the value that was rejected. It collapses nothing.
 *
 * The discriminator is what the payload field DESCRIBES. `column` on `unknown-column` is a fact
 * about the file's shape: one per file, and each one its own problem. `value` on `invalid-date`
 * is the offending cell: one per row, and the thing rows in a group differ by. So the key takes
 * every payload entry except those that vary per row, and `PER_ROW_PAYLOAD` names them.
 *
 * `scope.kind` joins the key because a header complaint and a row complaint are different
 * situations even under one code: one is about the file, the other about a line in it.
 *
 * ## Order is the file's order
 *
 * Groups appear in the order their first member did, and members keep their input order. A table
 * that reordered a user's file would make them hunt for a line number that is right there in
 * their spreadsheet.
 */
export interface InvalidRowGroup {
	/** Identity for the keyed each block. Stable: groups are never reordered or filtered. */
	key: string;
	/** The first member, whose fact and field the heading renders. */
	head: ImportInvalidRowDetail;
	/** Every member, the head included, in the order the file listed them. */
	rows: ImportInvalidRowDetail[];
	count: number;
}

/**
 * The payload fields that describe the offending ROW rather than the file.
 *
 * Each is checked against its own emit site rather than guessed:
 *  - `value`     — the rejected cell, on `invalid-date` and `invalid-nature`.
 *  - `currency`  — read per row, because `resolvedRows` checks the column on every line and a
 *                  file may mix.
 *  - `state`     — same, on the Revolut profile.
 *  - `actual`    — the column count this row happened to have, on `bad-column-count`. Its
 *                  sentence names no figure, so splitting on it would produce groups a reader
 *                  cannot tell apart.
 *
 * Everything absent from this list is a fact about the file — `column` on `unknown-column`,
 * `roles` on `mapping-columns-missing`, `violations` on `transaction-invalid` — and stays in the
 * key, because two of them are two problems.
 */
const PER_ROW_PAYLOAD = new Set(['value', 'currency', 'state', 'actual']);

function reasonKey(fact: ImportInvalidRowDetail['fact']): string {
	return (
		Object.entries(fact)
			.filter(([name]) => !PER_ROW_PAYLOAD.has(name))
			// Sorted, so the key does not depend on the order a parser happened to build the object
			// literal in. Two identical facts written with their keys transposed are one reason.
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([name, value]) => `${name}=${String(value)}`)
			.join(',')
	);
}

export function groupInvalidRows(details: ImportInvalidRowDetail[]): InvalidRowGroup[] {
	const groups = new Map<string, InvalidRowGroup>();

	for (const detail of details) {
		const key = `${detail.scope.kind}|${reasonKey(detail.fact)}|${detail.field ?? ''}`;
		const existing = groups.get(key);
		if (existing) {
			existing.rows.push(detail);
			existing.count += 1;
			continue;
		}
		// A Map preserves insertion order, which is what makes the file's order the table's
		// order without a sort — and a sort is what would need a comparator nobody can justify.
		groups.set(key, { key, head: detail, rows: [detail], count: 1 });
	}

	return [...groups.values()];
}
