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
