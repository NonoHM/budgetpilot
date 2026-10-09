import { createHmac, hkdfSync } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { readRateLimitSecret } from '$lib/server/auth/rateLimitSecret';

/**
 * The key a remembered account answer is stored under: a keyed hash of the file's FULL account
 * identifier, never the identifier and never its fragment (owner's ruling on #599, 2026-09-25).
 *
 * ## Why keyed, and why not a new secret
 *
 * A plain SHA-256 of an IBAN is not a protection: an IBAN is a short, structured string whose
 * checksum removes most of its freedom, so a digest of one is reversed by enumeration. A keyed
 * hash is reversed only by someone holding the key. The key is DERIVED from a secret the operator
 * already configures, `RATE_LIMIT_HASH_SECRET` (64 hex characters, checked at boot), rather than
 * added as a fourth one: a secret nobody has to set is a secret nobody can forget to set.
 *
 * ## Why derived, and not that secret used directly
 *
 * The rate limiter keys HMAC-SHA256 with the raw secret over emails and addresses. Using the same
 * key here would make one table's digests comparable with another's for any input the two share.
 * HKDF-SHA256 with a fixed context label gives this purpose its own 256-bit key, independent of
 * the limiter's for every practical purpose, and the label's version suffix is how a future change
 * of scheme is told apart from this one. ASVS v5.0.0-11.4.1 (an approved hash for HMAC and KDF),
 * ASVS v5.0.0-11.2.3 (256-bit key, 128 bits of security at least).
 *
 * ## What rotating the secret does
 *
 * Every stored key stops matching. Nothing is lost and nothing is misfiled: the next statement of
 * each remembered account is asked again, as if the answer had never been given, and answering it
 * remembers it under the new key. The answers given under the old secret stay listed in Settings
 * until forgotten, and never match again. The rate limiter's own counters reset at the same time.
 * `docs/configuration.md` says so where the variable is documented.
 */
export const ACCOUNT_MEMORY_KEY_LABEL = 'budgetpilot:account-memory:v1';

/** The purpose-bound key, from the configured secret's 32 bytes. Pure, for the spec. */
export function deriveAccountMemoryKey(secretHex: string): Buffer {
	return Buffer.from(
		hkdfSync('sha256', Buffer.from(secretHex, 'hex'), Buffer.alloc(0), ACCOUNT_MEMORY_KEY_LABEL, 32)
	);
}

/** The stored key for one canonical identifier, under a given derived key. Lowercase hex. */
/**
 * The stored key for one user's canonical identifier, under a given derived key. Lowercase hex.
 *
 * BOUND TO THE USER (contradiction pass): two users of one instance holding the same joint account
 * would otherwise store the same key, and anyone reading the table could link them. The pair is
 * serialised as a JSON array, so no choice of user id and identifier can collide with another pair.
 */
export function accountMemoryKeyWith(key: Buffer, userId: string, identifier: string): string {
	return createHmac('sha256', key)
		.update(JSON.stringify([userId, identifier]), 'utf8')
		.digest('hex');
}

let cached: { secret: string; key: Buffer } | undefined;

/**
 * The stored key for one canonical identifier, under THIS instance's secret.
 *
 * Read lazily, like the limiter's own: `readRateLimitSecret` throws with the operator's
 * sentence when the secret is absent or malformed, so a missing secret fails at the first use
 * rather than keying on `undefined`. Cached per secret value, so a changed value is picked up.
 */
export function accountMemoryKeyFor(userId: string, identifier: string): string {
	const secret = readRateLimitSecret(env);
	if (cached?.secret !== secret) cached = { secret, key: deriveAccountMemoryKey(secret) };
	return accountMemoryKeyWith(cached.key, userId, identifier);
}
