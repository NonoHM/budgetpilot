import { OperatorFacingError } from '../operatorFacingError.ts';

/**
 * THE ONE READING OF `RATE_LIMIT_HASH_SECRET`: what the limiter, the remembered accounts and the
 * log's pseudonyms key on, and what `scripts/log-pseudonym.mjs` must key on to print the value the
 * app logged (#942). A reader that trimmed differently, or skipped the check, would key on other
 * bytes and match nothing, silently. So every reader calls `readRateLimitSecret`, never
 * `source.RATE_LIMIT_HASH_SECRET` itself.
 *
 * No `$lib` or `$env` import, because a plain-Node script loads it; the caller passes its source
 * (`$env/dynamic/private` in the app, `process.env` in the script).
 */

// 64 hex characters is not a style preference: this value is used directly as an HMAC-SHA256 key
// in `hashRateLimitKey` (auth/rateLimit.ts) and to derive the log's keys, so its length IS the key strength (ASVS 5.0 V11.2.3, key size, and
// V11.5.1, entropy). docs/getting-started.md:388 has promised the format since the variable
// existed, `openssl rand -hex 32` at :66 produces it, and nothing enforced it — so
// `RATE_LIMIT_HASH_SECRET=changeme` was accepted and produced a 64-bit key, a security control the
// documentation claimed and the code did not have.
export function assertRateLimitSecretIn(source: NodeJS.ProcessEnv): void {
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

/** The secret as every reader keys on it: checked, then trimmed. Throws the check's sentence. */
export function readRateLimitSecret(source: NodeJS.ProcessEnv): string {
	assertRateLimitSecretIn(source);
	return source.RATE_LIMIT_HASH_SECRET!.trim();
}
