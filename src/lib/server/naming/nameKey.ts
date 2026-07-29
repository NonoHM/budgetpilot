import { createHash } from 'node:crypto';
import { normalizeForMatch } from '../../domain/normalize.ts';

/**
 * Collation-independent equality key for a user-supplied name.
 *
 * The app compares names for equality in two places that must agree: the uniqueness rules
 * on categories, buckets, budgets and net worth accounts, and the joins that match a
 * transaction's effective category against a budget or a nature mapping. Both used to run
 * as a raw SQL equality on user text, which is decided by the column's collation. That is
 * fine on SQLite (binary) and PostgreSQL (deterministic by default), and wrong on MySQL and
 * MariaDB, whose default collations are accent- and case-insensitive: "Café" and "cafe"
 * are one value there and two values everywhere else. Storing a key the app computes
 * itself makes the answer identical on every provider, with no operator action.
 *
 * The key is a hash rather than the readable normalized text on purpose. Normalized text
 * is still text, so a collation still gets to decide what equals what, and the folding
 * rules that remain differ per engine: `utf8mb4_general_ci` maps every character outside
 * the BMP to the same replacement, so all emoji compare equal, and the UCA collations fold
 * pairs like "ß"/"ss" that `normalizeForMatch` leaves distinct. A hex digest is pure ASCII,
 * so every collation compares it the same way, it is a fixed 64 characters regardless of
 * how long the name is (no `varchar(191)` overflow, no index key-length limit), and it
 * cannot be truncated into a false match.
 *
 * Two inputs collide only when they genuinely mean the same name. In particular:
 *
 * - **Emoji-only and other non-ASCII names** ("🎉", "Спорт", "食費") survive
 *   `normalizeForMatch` unchanged and therefore hash to distinct keys, instead of being
 *   folded together by whatever collation the operator's database happened to be created
 *   with.
 * - **Names that normalize to nothing** hash their raw text instead. A name made only of
 *   combining marks ("́") or of whitespace normalizes to the empty string, so hashing
 *   the normalized form alone would make every such name the same name and merge unrelated
 *   rows. These fall back to the raw text under a different domain prefix, which keeps them
 *   distinct from each other and, because the two prefixes never overlap, distinct from any
 *   name that normalizes normally.
 *
 * Not a security primitive: it protects no secret, and the readable name sits in the column
 * next to it. SHA-256 is used because it is the collision-resistant hash already available,
 * and a collision here would silently merge two categories' financial data.
 */
export function computeNameKey(rawName: string): string {
	const normalized = normalizeForMatch(rawName);
	// Domain-separated so the two branches can never produce the same digest for names
	// that are not the same name.
	const basis = normalized === '' ? `raw:${rawName}` : `norm:${normalized}`;
	return createHash('sha256').update(basis, 'utf8').digest('hex');
}

/** Convenience for the nullable columns: `null` in, `null` out. */
export function computeNullableNameKey(rawName: string | null): string | null {
	return rawName === null ? null : computeNameKey(rawName);
}
