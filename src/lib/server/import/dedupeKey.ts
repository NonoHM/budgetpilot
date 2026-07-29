import { createHash } from 'node:crypto';

/**
 * The collation- and length-independent equality key for a transaction's deduplication key.
 *
 * `dedupeKey` is a readable `|`-joined fingerprint of a row (date, label, amount, type,
 * reference, account). It is kept as-is on the transaction for traceability, but it must never
 * be the column a duplicate check compares, for two separate reasons:
 *
 * - **Collation.** `buildDeduplicationKey` lowercases, and nothing more. On MySQL and MariaDB,
 *   whose default collations are accent-insensitive, a payment labelled "Café" and one
 *   labelled "Cafe" then compare equal: two genuinely different transactions, one of them
 *   silently swallowed as a duplicate. Hashing decides the comparison in the app, where the
 *   answer is the same on every provider.
 * - **Length.** The key is unbounded, since a label can be long. A `String` under a unique
 *   index maps to `varchar(191)` by default on MySQL, and an index that only sees a prefix of
 *   the key merges transactions that differ past it. Truncating a deduplication key is silent
 *   financial data loss, so the compared value is a fixed 64 ASCII characters instead.
 *
 * **What this does not do yet.** The unique constraint still sits on the raw `dedupeKey`, and
 * moving it onto the hash belongs to the multi-database work, for the same reason the name
 * keys were staged that way: `prisma migrate deploy` runs before any app code, so the
 * constraint cannot be created in the release that first populates the column it covers. Until
 * then the raw index still governs inserts on a provider whose collation folds accents, so
 * `persistTransaction` treats a conflict the hash says is not a duplicate as an error rather
 * than swallowing the row. Loud beats silent: the transaction is never dropped without saying
 * so. Moving that constraint is a hard prerequisite for shipping any non-SQLite provider.
 *
 * Deliberately NOT `computeNameKey` (see server/naming/nameKey.ts): that one folds case and
 * accents on purpose, because two spellings of a category name mean the same category. Here
 * the opposite holds. Two fingerprints that differ at all describe two different transactions,
 * so the hash is taken over the raw key with no folding.
 */
export function computeDedupeKeyHash(dedupeKey: string): string {
	return createHash('sha256').update(dedupeKey, 'utf8').digest('hex');
}

/** Convenience for the nullable column: `null` (or empty) in, `null` out. */
export function computeNullableDedupeKeyHash(dedupeKey: string | null | undefined): string | null {
	return dedupeKey ? computeDedupeKeyHash(dedupeKey) : null;
}

/**
 * The Prisma `data` fragment for writing a transaction's deduplication key.
 *
 * The pair is expressed once so no write path can set the raw key without its hash: a row
 * written with the hash missing is invisible to every duplicate check, which is exactly the
 * import re-importing itself.
 */
export function dedupeKeyUpdate(dedupeKey: string | null | undefined): {
	dedupeKey: string | null;
	dedupeKeyHash: string | null;
} {
	return {
		dedupeKey: dedupeKey || null,
		dedupeKeyHash: computeNullableDedupeKeyHash(dedupeKey)
	};
}
