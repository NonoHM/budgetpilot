import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';
import { deriveAccountMemoryKey } from '$lib/server/import/accountMemoryKey';
import {
	deriveLogPseudonymKey,
	LOG_PSEUDONYM_KEY_LABEL,
	logPseudonym,
	logPseudonymWith
} from './pseudonym';

/**
 * The log pseudonym (rulings R1 and R9 on #841). Every expectation is built by calling a
 * production function or the primitive it is defined by, never typed as a digest.
 */

const SECRET = 'ab'.repeat(32);
const ROTATED = 'cd'.repeat(32);
const ADDRESS = '203.0.113.7';
const saved = env.RATE_LIMIT_HASH_SECRET;

afterEach(() => {
	env.RATE_LIMIT_HASH_SECRET = saved;
});

describe('logPseudonym', () => {
	it('is the HMAC-SHA256 of the value under the key HKDF derives with the ruled label', () => {
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		expect(LOG_PSEUDONYM_KEY_LABEL).toBe('budgetpilot:log-pseudonym:v1');
		expect(logPseudonym(ADDRESS)).toBe(
			createHmac('sha256', deriveLogPseudonymKey(SECRET)).update(ADDRESS).digest('hex')
		);
	});

	it('never equals the limiter digest of the same address, so a log line does not join to LoginAttempt', () => {
		// The limiter keys HMAC-SHA256 with the raw secret over the trimmed, lowercased value
		// (`hashRateLimitKey`, auth/rateLimit.ts).
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		const limiter = createHmac('sha256', SECRET).update(ADDRESS.trim().toLowerCase()).digest('hex');
		expect(logPseudonym(ADDRESS)).not.toBe(limiter);
	});

	it('uses a key of its own, distinct from the account-memory key derived from the same secret', () => {
		expect(deriveLogPseudonymKey(SECRET).equals(deriveAccountMemoryKey(SECRET))).toBe(false);
		expect(deriveLogPseudonymKey(SECRET)).toHaveLength(32);
	});

	it('rotates with the secret: the same address under a rotated secret is another pseudonym', () => {
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		const before = logPseudonym(ADDRESS);
		env.RATE_LIMIT_HASH_SECRET = ROTATED;
		const after = logPseudonym(ADDRESS);
		expect([
			before === after,
			after === logPseudonymWith(deriveLogPseudonymKey(ROTATED), ADDRESS)
		]).toEqual([false, true]);
	});

	it('refuses to key on an absent secret rather than hashing under undefined', () => {
		env.RATE_LIMIT_HASH_SECRET = '';
		expect(() => logPseudonym(ADDRESS)).toThrow(/RATE_LIMIT_HASH_SECRET/);
	});
});
