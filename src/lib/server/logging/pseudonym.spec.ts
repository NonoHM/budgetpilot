import { createHmac } from 'node:crypto';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

/**
 * #869: one client, one pseudonym. The value is an address, and an address has many spellings
 * (case, leading zeros, which zero run `::` stands for, an embedded dotted quad, the IPv4-mapped
 * form a dual-stack socket reports). Hashing the spelling made one client read as several sources.
 *
 * The oracle for the canonical text is the WHATWG URL host serializer, which this module does not
 * call: it writes IPv6 lowercase, without leading zeros, with `::` on the first longest run of two
 * or more zero groups, which is RFC 5952 section 4. The one rule it does not carry is the fold of
 * an IPv4-mapped address to its IPv4 client, written here once as the ruling.
 */
describe('logPseudonym normalises the address before keying it (#869)', () => {
	const key = deriveLogPseudonymKey(SECRET);
	const keyed = (canonical: string) =>
		createHmac('sha256', key).update(canonical, 'utf8').digest('hex');

	/** RFC 5952 text of eight 16-bit groups, by an independent serializer; mapped folds to IPv4. */
	function oracle(groups: readonly number[], zone?: string): string {
		const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
		const text = mapped
			? [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.')
			: new URL(`http://[${groups.map((g) => g.toString(16)).join(':')}]/`).hostname.slice(1, -1);
		return zone === undefined ? text : `${text}%${zone}`;
	}

	const group = fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 0xffff }));
	const v6 = fc.array(group, { minLength: 8, maxLength: 8 });
	const v4 = fc
		.array(fc.integer({ min: 0, max: 255 }), { minLength: 4, maxLength: 4 })
		.map(([a, b, c, d]) => [0, 0, 0, 0, 0, 0xffff, (a << 8) | b, (c << 8) | d]);
	const address = fc.oneof(v6, v4);

	/** One valid spelling of the address: any case, any zero padding, any `::`, a dotted tail. */
	const spelling = (groups: readonly number[]) =>
		fc
			.record({
				pad: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 8, maxLength: 8 }),
				upper: fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
				compress: fc.option(fc.nat(7), { nil: undefined }),
				dottedTail: fc.boolean(),
				space: fc.constantFrom('', ' ', '\t')
			})
			.map(({ pad, upper, compress, dottedTail, space }) => {
				const parts = groups.map((g, i) => {
					const hex = g.toString(16).padStart(pad[i], '0');
					return upper[i] ? hex.toUpperCase() : hex;
				});
				const tail = dottedTail
					? [`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`]
					: parts.slice(6);
				const all = [...parts.slice(0, 6), ...tail];
				// `::` may stand for any run of one or more zero groups (RFC 4291 section 2.2).
				let text = all.join(':');
				if (compress !== undefined && groups[compress] === 0) {
					let end = compress;
					while (end + 1 < 8 && groups[end + 1] === 0) end += 1;
					const width = dottedTail ? 6 : 8;
					if (end < width) {
						text = `${all.slice(0, compress).join(':')}::${all.slice(end + 1).join(':')}`;
					}
				}
				return `${space}${text}${space}`;
			});

	beforeEach(() => {
		env.RATE_LIMIT_HASH_SECRET = SECRET;
	});

	it('keys the spellings the issue names to one pseudonym each (planted positives)', () => {
		expect([
			logPseudonym('2001:db8:0:0:0:0:0:1') === logPseudonym('2001:db8::1'),
			logPseudonym('2001:DB8::1') === logPseudonym('2001:db8::1'),
			logPseudonym('::ffff:203.0.113.7') === logPseudonym('203.0.113.7'),
			logPseudonym(' 203.0.113.7 ') === logPseudonym('203.0.113.7')
		]).toEqual([true, true, true, true]);
	});

	it('keys the RFC 5952 text, so a pseudonym is reproducible from the address alone', () => {
		expect(logPseudonym('2001:0DB8:0000:0000:0001:0000:0000:0001')).toBe(
			keyed('2001:db8::1:0:0:1')
		);
		expect(logPseudonym('::FFFF:CB00:7107')).toBe(keyed('203.0.113.7'));
	});

	it('gives every spelling of one address the pseudonym of its canonical text (property)', () => {
		fc.assert(
			fc.property(
				address.chain((groups) => fc.tuple(fc.constant(groups), spelling(groups))),
				([groups, text]) => logPseudonym(text) === keyed(oracle(groups))
			),
			{ seed: 869, numRuns: 2000 }
		);
	});

	it('never merges two different addresses: injective over the canonical form (property)', () => {
		fc.assert(
			fc.property(address, address, (a, b) => {
				fc.pre(oracle(a) !== oracle(b));
				return logPseudonym(oracle(a)) !== logPseudonym(oracle(b));
			}),
			{ seed: 869, numRuns: 2000 }
		);
		// An IPv4-compatible address (deprecated, RFC 4291 section 2.5.5.1) is not its IPv4 client:
		// only the mapped form folds.
		expect(logPseudonym('::203.0.113.7')).not.toBe(logPseudonym('203.0.113.7'));
	});

	it('keeps a zone index verbatim after the canonical address, as Node reports a link-local peer', () => {
		expect(logPseudonym('FE80:0:0:0:0:0:0:1%eth0')).toBe(keyed('fe80::1%eth0'));
		expect(
			new Set([
				logPseudonym('fe80::1%eth0'),
				logPseudonym('fe80::1%eth1'),
				logPseudonym('fe80::1%ETH0'),
				logPseudonym('fe80::1')
			]).size
		).toBe(4);
	});

	it('applies the same normalisation through the pure entry point the spec and tools call', () => {
		expect(logPseudonymWith(key, '2001:DB8:0::1')).toBe(keyed('2001:db8::1'));
	});

	it.each([
		['an empty value', ''],
		['an email address', 'paul.mercier@example.test'],
		['three octets', '203.0.113'],
		['a leading-zero octet', '203.0.113.07'],
		['an address with a port', '203.0.113.7:443'],
		['two `::`', '2001::db8::1'],
		['an empty zone', 'fe80::1%'],
		['a bracketed address', '[2001:db8::1]']
	])('refuses %s rather than hashing it, and does not echo it', (_label, value) => {
		let message = '';
		try {
			logPseudonym(value);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/not an IP address/);
		if (value !== '') expect(message).not.toContain(value);
	});
});
