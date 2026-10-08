import { createHmac, hkdfSync } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { assertRateLimitSecretConfigured } from '$lib/server/auth/rateLimit';
import { canonicalIpText } from '$lib/server/net/clientAddress';

/**
 * The log pseudonym: what a client address becomes before it may enter a log line (ruling R1 on
 * #841: « The client IP is logged only as an HMAC under the log-only key (R9), never raw and never
 * truncated », and only on authentication events and the rate limiter's refusal of an
 * authentication kind). No event in this module's first pull request carries one; the mechanism
 * exists so that the events that will are written against a type that only this function produces.
 *
 * THE KEY (ruling R9). Derived by HKDF-SHA256 from `RATE_LIMIT_HASH_SECRET` under its own label,
 * following `import/accountMemoryKey.ts`, and rotating with that secret. No override variable: one
 * is added when someone needs to rotate the log key apart from the limiter, which is reversible.
 * The label separates this purpose from the limiter's raw-secret HMAC, so a logged pseudonym never
 * equals a stored `LoginAttempt.ipHash` and a log line does not join to the database.
 * ASVS v5.0.0-11.4.1 and v5.0.0-11.2.3 apply as they do to the precedent.
 *
 * WHAT IT PROTECTS, plainly. An IPv4 address has 32 bits, so whoever holds `.env` can reverse every
 * logged address by enumeration; that is the operator. The protection is against every other
 * reader of the log: a collector, a SIEM, a leaked file. Rotating the secret breaks correlation
 * across the rotation date.
 *
 * ONE ADDRESS, ONE PSEUDONYM (#869). What is keyed is `canonicalIpText` of the value, never the
 * value as given: hashing the spelling made one client read as several sources (`2001:db8::1` and
 * `2001:DB8:0:0:0:0:0:1`, an IPv4 client and its `::ffff:` form). A value that is not an address
 * throws rather than being hashed, without the value in the message, which could reach a log. A
 * zone index is kept as the peer reports it: Node writes the interface name on Linux and a number
 * on Windows, so one platform gives one spelling. The value comes from `resolveClientAddress`,
 * which can still hand over a non-address: adapter-node returns `undefined` once the client has
 * disconnected (the limiter's own key throws on it too). An authentication event therefore takes
 * its pseudonym AFTER `recordFailedLoginAttempt`, never before, so that a throw cannot skip the
 * record.
 */
export const LOG_PSEUDONYM_KEY_LABEL = 'budgetpilot:log-pseudonym:v1';

declare const logPseudonymBrand: unique symbol;
/** A keyed hash under the log key. Not constructible from a plain string outside this module. */
export type LogPseudonym = string & { readonly [logPseudonymBrand]: true };

/** The purpose-bound key, from the configured secret's 32 bytes. Pure, for the spec. */
export function deriveLogPseudonymKey(secretHex: string): Buffer {
	return Buffer.from(
		hkdfSync('sha256', Buffer.from(secretHex, 'hex'), Buffer.alloc(0), LOG_PSEUDONYM_KEY_LABEL, 32)
	);
}

/** The pseudonym of one address under a given derived key. Lowercase hex. Throws on a non-address. */
export function logPseudonymWith(key: Buffer, value: string): LogPseudonym {
	const canonical = canonicalIpText(value);
	if (canonical === null) throw new Error('log pseudonym: the value is not an IP address');
	return createHmac('sha256', key).update(canonical, 'utf8').digest('hex') as LogPseudonym;
}

let cached: { secret: string; key: Buffer } | undefined;

/** The pseudonym under THIS instance's secret, read lazily like the limiter's own. */
export function logPseudonym(value: string): LogPseudonym {
	assertRateLimitSecretConfigured(env);
	const secret = env.RATE_LIMIT_HASH_SECRET!.trim();
	if (cached?.secret !== secret) cached = { secret, key: deriveLogPseudonymKey(secret) };
	return logPseudonymWith(cached.key, value);
}
