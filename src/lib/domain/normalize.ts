/**
 * Folds a user-supplied string to its comparison form: accents stripped, lowercased,
 * trimmed. The single definition of "these two names are the same name" for the whole app.
 *
 * Used on both sides of the same question, in two shapes that must agree:
 *
 * - **In JavaScript**, wherever names are matched in memory: categorization rules, the label
 *   filter, and the joins that match a transaction's effective category against a budget or
 *   a nature mapping.
 * - **In the database**, through `server/naming/nameKey.ts`, which hashes this function's
 *   output into the stored key columns. SQL equality on raw text is decided by the column's
 *   collation and therefore answers differently per database engine, so the comparison is
 *   moved to a value the app computes rather than one the engine interprets.
 *
 * Both derive from here, so two names are equal in memory exactly when their stored keys are
 * equal. Changing the folding rules changes both, and requires recomputing the stored keys.
 *
 * Lives in `domain/` rather than beside its server-side callers because it is pure logic with
 * no infrastructure, and because the budget aggregation that needs it also ships to the
 * browser.
 */
export function normalizeForMatch(value: string): string {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.trim();
}

export interface MatchSegment {
	text: string;
	matched: boolean;
}

/**
 * Splits `text` around the first case/accent-insensitive occurrence of `query`, for bolding a
 * matched substring (TagPicker state C) without `{@html}`: the caller renders `matched` segments
 * as an element (e.g. `<strong>`) and the rest as plain text, so no raw HTML is ever interpreted.
 *
 * Matches anywhere in the string, not only a prefix \u2014 the same rule `filtered` in TagPicker
 * already applies via `normalizeForMatch(...).includes(...)`, so a name that appears in the
 * filtered list always produces a `matched` segment here.
 *
 * Folds one character at a time (rather than normalizeForMatch on the whole string) so the
 * match index found in the folded copy lines up with the same index in `text`. A whole-string
 * NFD normalize can change length \u2014 a precomposed accented character decomposes into a base
 * character plus a combining mark \u2014 which would misalign a substring slice taken from the
 * folded string against the original.
 */
export function highlightMatchSegments(text: string, query: string): MatchSegment[] {
	const trimmedQuery = query.trim();
	if (trimmedQuery === '') return [{ text, matched: false }];

	const foldChar = (ch: string): string =>
		ch
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '')
			.toLowerCase();

	const chars = Array.from(text);
	const folded = chars.map(foldChar).join('');
	const foldedQuery = Array.from(trimmedQuery).map(foldChar).join('');

	const start = folded.indexOf(foldedQuery);
	if (start === -1) return [{ text, matched: false }];

	const before = chars.slice(0, start).join('');
	const matched = chars.slice(start, start + foldedQuery.length).join('');
	const after = chars.slice(start + foldedQuery.length).join('');

	const segments: MatchSegment[] = [];
	if (before) segments.push({ text: before, matched: false });
	segments.push({ text: matched, matched: true });
	if (after) segments.push({ text: after, matched: false });
	return segments;
}
