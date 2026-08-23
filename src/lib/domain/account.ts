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

/**
 * The name the generic CSV bucket is STORED under. A key, never a sentence shown to anyone.
 *
 * It reads like display copy and it is not: it is half of `@@unique([userId, name, source])`, and
 * this repository has one expensive instance of exactly that confusion. « Compte import CSV » was
 * ALSO the bucket lookup key, so translating it would have orphaned every transaction in an English
 * user's first bucket. The rule it produced is the one this constant exists to keep visible: a
 * localised string does not live in a database column.
 *
 * So the value never moves and is never translated. The screens SUBSTITUTE a message for it at
 * render time, which is the same move `importProfileLabel` already makes: rendering only, never
 * storage. The two banks we can name get a real proper noun written into the row by the boot
 * backfill; this one has no proper noun to write, which is precisely why it keeps a rendering rule
 * and they do not.
 */
export const GENERIC_BUCKET_STORED_NAME = 'Compte import CSV';
