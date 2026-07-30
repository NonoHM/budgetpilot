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
 * The unique constraint sits on this hash, not on the raw key. It was staged that way on
 * purpose, over two releases: `prisma migrate deploy` runs before any app code, so the
 * constraint could not be created in the release that first populated the column it covers.
 * The column landed first, the constraint followed once every row carried a value.
 *
 * `persistTransaction` still re-queries on the hash before treating a unique violation as a
 * duplicate. That is not leftover caution from the staging: it is the permanent guard that
 * separates "the row really is already there" from "some constraint we did not anticipate".
 * Loud beats silent, because the alternative is counting a real transaction as a duplicate and
 * dropping it without a word.
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
