/**
 * Which `Account` rows are accounts a statement can come FROM.
 *
 * Imports nothing, deliberately. `domain/money.ts` failed at container startup after `check` over
 * 3 767 files, 4 000 unit tests, `lint:tracked` and a full Playwright run had all passed, and the
 * import path was the symptom rather than the cause. A domain predicate reaches for nothing.
 *
 * ## An EXCLUSION set, and the asymmetry is the reason
 *
 * An inclusion list that forgets a new connector HIDES a real account, and nothing is able to
 * notice: the account simply does not appear, and an absence has no error message. An exclusion
 * list that forgets one OFFERS a destination the user can see and correct. The failure directions
 * are not symmetric, and the visible one is the one this repository chooses.
 *
 * Three callers read this: the Comptes list, the import picker and the invitation sentence. They
 * agree by construction rather than by review, and `account.spec.ts` asserts that.
 */
const NON_STATEMENT_SOURCES = new Set<string>(['manual']);

export function isStatementAccount(account: { source: string }): boolean {
	return !NON_STATEMENT_SOURCES.has(account.source);
}
