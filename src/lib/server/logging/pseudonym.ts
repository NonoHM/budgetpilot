import { createHmac, hkdfSync } from 'node:crypto';
import { env } from '$env/dynamic/private';
// Order kept on purpose: with the secret assertion first and a name after it on the next line,
// gitleaks' generic-api-key rule reads that name as a secret value.
import {
	rateLimitIpv6PrefixBits,
	assertRateLimitSecretConfigured
} from '$lib/server/auth/rateLimit';
import { addressSubnet, canonicalIpText } from '$lib/server/net/clientAddress';

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

/**
 * THE SUBNET LABEL (owner ruling 2026-10-08 on #869). The pseudonym above follows the full address,
 * as R1 rules, so one IPv6 subscriber rotating through the block it was given reads as many
 * sources while the limiter counts it once. The subnet label is the limiter's bucket
 * (`addressSubnet` at `BP_RATE_LIMIT_IPV6_PREFIX`) keyed under a key of its own, so an event can log
 * both: who exactly, and which subscriber the limiter counted.
 *
 * What is hashed is CIDR text with its width, so a change of the setting changes every IPv6 label
 * rather than silently reusing one whose masked bits happen to agree. An address the limiter counts
 * as IPv4 (the mapped form, the NAT64 prefix 64:ff9b::/96) carries its IPv4 client's label, by the
 * same rule. Its own HKDF label, so the two fields never hold equal values (for IPv4 they would,
 * which tells a reader the family, and a NAT64 line would match a native client's pseudonym). NIST
 * SP 800-57 Part 1 Rev. 5 section 5.2 asks that « a single key shall be used for only one purpose »;
 * these are two purposes of one process, separated anyway because separating them costs one label.
 */
export const LOG_SUBNET_KEY_LABEL = 'budgetpilot:log-subnet:v1';

const NOT_AN_ADDRESS = 'log pseudonym: the value is not an IP address';

declare const logPseudonymBrand: unique symbol;
/** A keyed hash under the log key. Not constructible from a plain string outside this module. */
export type LogPseudonym = string & { readonly [logPseudonymBrand]: true };

declare const logSubnetPseudonymBrand: unique symbol;
/** A keyed hash of a subscriber's prefix. A type of its own, so it cannot fill an address field. */
export type LogSubnetPseudonym = string & { readonly [logSubnetPseudonymBrand]: true };

function deriveKey(secretHex: string, label: string): Buffer {
	return Buffer.from(hkdfSync('sha256', Buffer.from(secretHex, 'hex'), Buffer.alloc(0), label, 32));
}

/** The purpose-bound key, from the configured secret's 32 bytes. Pure, for the spec. */
export function deriveLogPseudonymKey(secretHex: string): Buffer {
	return deriveKey(secretHex, LOG_PSEUDONYM_KEY_LABEL);
}

/** The subnet label's key, under its own label. Pure, for the spec. */
export function deriveLogSubnetKey(secretHex: string): Buffer {
	return deriveKey(secretHex, LOG_SUBNET_KEY_LABEL);
}

/** The pseudonym of one address under a given derived key. Lowercase hex. Throws on a non-address. */
export function logPseudonymWith(key: Buffer, value: string): LogPseudonym {
	const canonical = canonicalIpText(value);
	if (canonical === null) throw new Error(NOT_AN_ADDRESS);
	return createHmac('sha256', key).update(canonical, 'utf8').digest('hex') as LogPseudonym;
}

/**
 * The subnet label of one address under a given subnet key and prefix. Refuses a non-address
 * before reaching the limiter's rule, which keys such text as written.
 */
export function logSubnetPseudonymWith(
	key: Buffer,
	value: string,
	v6PrefixBits: number
): LogSubnetPseudonym {
	const canonical = canonicalIpText(value);
	const subnet = canonical === null ? null : addressSubnet(canonical, v6PrefixBits);
	if (subnet === null) throw new Error(NOT_AN_ADDRESS);
	return createHmac('sha256', key).update(subnet, 'utf8').digest('hex') as LogSubnetPseudonym;
}

let cached: { secret: string; address: Buffer; subnet: Buffer } | undefined;

/** Both keys under THIS instance's secret, read lazily like the limiter's own. */
function instanceKeys(): { address: Buffer; subnet: Buffer } {
	assertRateLimitSecretConfigured(env);
	const secret = env.RATE_LIMIT_HASH_SECRET!.trim();
	if (cached?.secret !== secret) {
		cached = { secret, address: deriveLogPseudonymKey(secret), subnet: deriveLogSubnetKey(secret) };
	}
	return cached;
}

/** The pseudonym under THIS instance's secret. */
export function logPseudonym(value: string): LogPseudonym {
	return logPseudonymWith(instanceKeys().address, value);
}

/** The subnet label under THIS instance's secret, at the prefix the limiter reads now. */
export function logSubnetPseudonym(value: string): LogSubnetPseudonym {
	return logSubnetPseudonymWith(instanceKeys().subnet, value, rateLimitIpv6PrefixBits());
}
