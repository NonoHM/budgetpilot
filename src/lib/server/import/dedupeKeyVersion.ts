/**
 * Which deduplication key version this build writes, and how to read the version off a stored one.
 *
 * ## Why a prefix inside the hashed string, rather than a column
 *
 * The obvious argument for a column is that you can query which rows are on which version, and the
 * obvious argument for a prefix is that two versions cannot collide. Both are true, and the prefix
 * wins on a third point that only appears when you ask how the migration FAILS. `prisma migrate
 * deploy` wraps nothing in a transaction on any engine, which is why every backfill in this
 * repository is boot-time app code rather than SQL. So a partial population is reachable, and
 * "which rows are still pending" has to be answerable. The prefix answers it against the column
 * that already exists, delivering the column's advantage as well as its own, and a column would be
 * a second thing to keep in sync with the string it describes.
 *
 * It sits INSIDE the hashed string, never beside it. `computeDedupeKeyHash` is what the unique
 * constraint compares (see `dedupeKey.ts`), so a marker anywhere else would leave two versions able
 * to collide on the compared value, which is the exact false-duplicate the key exists to prevent.
 *
 * ## Why an unprefixed key is only ever "legacy"
 *
 * v1 and v2 are not distinguishable from the string alone, and nothing needs them to be. The only
 * question anything asks is whether a row is on the version this build writes.
 *
 * A legacy key cannot be mistaken for a current one, and the reason is a property of the format
 * rather than a hope: v1 and v2 both open with the transaction's `YYYY-MM-DD` date, so neither can
 * open with the marker. A label containing the literal `v3|` is harmless, because a label is never
 * the first field.
 */
export const DEDUPE_KEY_VERSION = 3;

/**
 * The literal that opens every key this build writes, and the backfill's pending predicate.
 *
 * Derived from the version rather than spelled a second time: two literals is how the marker the
 * predicate compares and the number a reader reasons about quietly stop agreeing. The trailing
 * separator is part of it so a marker can never merge into the first field.
 */
export const DEDUPE_KEY_PREFIX = `v${DEDUPE_KEY_VERSION}|`;

/** `null` for a row that was never keyed, which is a manual transaction and not a pending one. */
export function dedupeKeyVersionOf(
	key: string | null | undefined
): typeof DEDUPE_KEY_VERSION | 'legacy' | null {
	if (!key) return null;
	return key.startsWith(DEDUPE_KEY_PREFIX) ? DEDUPE_KEY_VERSION : 'legacy';
}

export function isCurrentDedupeKeyVersion(key: string | null | undefined): boolean {
	return dedupeKeyVersionOf(key) === DEDUPE_KEY_VERSION;
}
