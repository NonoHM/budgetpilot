import { env } from '$env/dynamic/private';
import { readIntegerSetting } from '$lib/server/env/readSetting';
import { OperatorFacingError } from '$lib/server/operatorFacingError';

/**
 * The two readings the rate limiter and the log's pseudonyms share (`auth/rateLimit.ts`,
 * `logging/pseudonym.ts`): the secret both key on, and the prefix an IPv6 client is counted by.
 * One module of their own so that neither copy can drift, and so that a spec replacing the limiter
 * does not replace what the log reads.
 */

// 64 hex characters is not a style preference: this value is used directly as an HMAC-SHA256 key
// in `hashRateLimitKey` (auth/rateLimit.ts) and to derive the log's keys, so its length IS the key strength (ASVS 5.0 V11.2.3, key size, and
// V11.5.1, entropy). docs/getting-started.md:388 has promised the format since the variable
// existed, `openssl rand -hex 32` at :66 produces it, and nothing enforced it — so
// `RATE_LIMIT_HASH_SECRET=changeme` was accepted and produced a 64-bit key, a security control the
// documentation claimed and the code did not have. Exported for the boot collector and its spec.
export function assertRateLimitSecretConfigured(source: NodeJS.ProcessEnv = env): void {
	const raw = source.RATE_LIMIT_HASH_SECRET?.trim();
	if (!raw) {
		throw new OperatorFacingError(
			'RATE_LIMIT_HASH_SECRET is required: it is the HMAC key that hashes the emails and IP ' +
				'addresses recorded for login rate limiting, so without it the limiter has nothing to ' +
				'key on. Set it to 64 hex characters (generate one with `openssl rand -hex 32`).'
		);
	}
	if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
		throw new OperatorFacingError(
			`RATE_LIMIT_HASH_SECRET must be exactly 64 hex characters (received ${raw.length}). It is ` +
				'used directly as an HMAC-SHA256 key, so a shorter value is a weaker key rather than a ' +
				'shorter name. Generate one with `openssl rand -hex 32`.'
		);
	}
}

/**
 * The prefix an IPv6 client is counted by, read per call. Exported so the log's subnet label
 * (`logging/pseudonym.ts`) reads the same setting the counter does, never a copy of it.
 */
export function rateLimitIpv6PrefixBits(): number {
	return readIntegerSetting('BP_RATE_LIMIT_IPV6_PREFIX');
}
