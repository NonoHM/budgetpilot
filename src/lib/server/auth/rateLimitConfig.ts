import { env } from '$env/dynamic/private';
import { readIntegerSetting } from '$lib/server/env/readSetting';
import { assertRateLimitSecretIn } from './rateLimitSecret';

/**
 * The two readings the rate limiter and the log's pseudonyms share (`auth/rateLimit.ts`,
 * `logging/pseudonym.ts`): the secret both key on, and the prefix an IPv6 client is counted by.
 * One module of their own so that neither copy can drift, and so that a spec replacing the limiter
 * does not replace what the log reads.
 */

// The check itself lives in `rateLimitSecret.ts`, alias-free for `scripts/log-pseudonym.mjs`. This
// wrapper keeps the `$env` default and stays the one function object the boot collector and
// `rateLimit.ts` both export (`rateLimit.spec.ts` asserts the identity). Exported for the boot
// collector and its spec.
export function assertRateLimitSecretConfigured(source: NodeJS.ProcessEnv = env): void {
	assertRateLimitSecretIn(source);
}

/**
 * The prefix an IPv6 client is counted by, read per call. Exported so the log's subnet label
 * (`logging/pseudonym.ts`) reads the same setting the counter does, never a copy of it.
 */
export function rateLimitIpv6PrefixBits(): number {
	return readIntegerSetting('BP_RATE_LIMIT_IPV6_PREFIX');
}
