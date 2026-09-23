import { sanitizeImportedText } from './utils/safety';

/**
 * WHICH CURRENCY A FILE DECLARES, read off every row (#600).
 *
 * A file-level decision in AGENTS.md's sense: the currency a statement is in is a property of the
 * FILE, so it is decided by looking at every value it ranges over, never only at the rows that
 * went on to become transactions. The contradiction pass on #600 measured the difference (F2): a
 * file whose one declaring row was refused for its date filed its other row under a USD account's
 * currency, while the same file with a valid date was refused.
 *
 * What counts as a declaration is a cell the profile ACCEPTS as a currency. A cell naming another
 * currency is refused on its own row (`unsupported-currency`), with its own sentence, and is left
 * out here: counting it would refuse a file's euro rows for the sake of a row already refused.
 * A blank cell declares nothing, which is the file-evidence rule's « exhibits nothing ».
 *
 * Returns the distinct codes, in the order first met. A list rather than a single code because
 * nothing here can promise a file declares only one: today the accepted set is EUR alone, so the
 * list is `[]` or `['EUR']`.
 */
export function acceptedDeclarations(
	cells: Iterable<string>,
	accepted: string,
	/** The profile's own acceptance test, so a cell counts here exactly when its row accepts it.
	 *  Case-insensitive by default, which is `resolvedRows.ts`'s rule; Revolut's is exact. */
	accepts: (declared: string) => boolean = (declared) => declared.toUpperCase() === accepted
): string[] {
	const found = new Set<string>();
	for (const cell of cells) {
		const declared = sanitizeImportedText(cell);
		if (declared && accepts(declared)) found.add(accepted);
	}
	return [...found];
}
