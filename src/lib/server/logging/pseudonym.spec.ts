import { createHmac } from 'node:crypto';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '$env/dynamic/private';
import { deriveAccountMemoryKey } from '$lib/server/import/accountMemoryKey';
import { rateLimitAddressKey } from '$lib/server/net/clientAddress';
import {
	deriveLogPseudonymKey,
	LOG_PSEUDONYM_KEY_LABEL,
	logPseudonym,
	logPseudonymWith,
	deriveLogSubnetKey,
	LOG_SUBNET_KEY_LABEL,
	logSubnetPseudonym,
	logSubnetPseudonymWith,
	type LogPseudonym
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
	it('is the HMAC-SHA256 of the canonical address under the key HKDF derives with the ruled label', () => {
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		expect(LOG_PSEUDONYM_KEY_LABEL).toBe('budgetpilot:log-pseudonym:v1');
		expect(logPseudonym(ADDRESS)).toBe(
			createHmac('sha256', deriveLogPseudonymKey(SECRET)).update(ADDRESS).digest('hex')
		);
	});

	it('never equals the limiter digest of the same address, so a log line does not join to LoginAttempt', () => {
		// The limiter keys HMAC-SHA256 with the raw secret over `rateLimitAddressKey`'s text,
		// trimmed and lowercased (`hashAddress`, auth/rateLimit.ts, not exported). The key text
		// comes from the production function; only the HMAC around it is retyped here. IPv4 only:
		// an IPv6 key text starts `v6:` and the canonical text never does, so an IPv6 row would stay
		// green with the two keys merged.
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		const keyText = rateLimitAddressKey(ADDRESS, 56).trim().toLowerCase();
		expect(keyText).toBe(ADDRESS);
		const limiter = createHmac('sha256', SECRET).update(keyText).digest('hex');
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
	// Not the unspecified address `::`: `parseIp` refuses it (#933), and no peer carries it (RFC 4291
	// section 2.5.2: it « must never be assigned to any node »).
	const v6 = fc
		.array(group, { minLength: 8, maxLength: 8 })
		.filter((groups) => groups.some((g) => g !== 0));
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
				// `expect` inside the predicate: vite.config sets requireAssertions, and a boolean
				// predicate counts no assertion.
				([groups, text]) => {
					expect(logPseudonym(text)).toBe(keyed(oracle(groups)));
				}
			),
			{ seed: 869, numRuns: 2000 }
		);
	});

	// Green before the fix by construction (an unnormalised HMAC merges nothing): it guards the fix
	// against a normalisation that folds two addresses into one, not against the defect #869 names.
	it('does not merge two different addresses into one pseudonym (property)', () => {
		fc.assert(
			fc.property(address, address, (a, b) => {
				fc.pre(oracle(a) !== oracle(b));
				expect(logPseudonym(oracle(a))).not.toBe(logPseudonym(oracle(b)));
			}),
			{ seed: 869, numRuns: 2000 }
		);
	});

	it('folds only the mapped form: an IPv4-compatible or NAT64 address is not its IPv4 client', () => {
		// IPv4-compatible is deprecated (RFC 4291 section 2.5.5.1). NAT64 (RFC 6052) is folded by the
		// limiter, which counts subscribers; the pseudonym names the address it was given.
		expect([
			logPseudonym('::203.0.113.7') === logPseudonym('203.0.113.7'),
			logPseudonym('64:ff9b::203.0.113.7') === logPseudonym('203.0.113.7')
		]).toEqual([false, false]);
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

	/**
	 * A zone as Node writes it: one character per byte of the kernel's name, Latin-1 decoded. Measured
	 * on Node 24.18 with dummy interfaces in a throwaway network namespace: `réseau-maison1` (15
	 * UTF-8 bytes) arrives as 15 characters, `rÃ©seau-maison1`; a 16-byte name is refused by the
	 * kernel before Node sees it.
	 */
	const asNodeWritesIt = (name: string) => Buffer.from(name, 'utf8').toString('latin1');

	it('accepts every interface name Linux accepts as a zone, as Node writes it, kept verbatim', () => {
		// dev_valid_name (net/core/dev.c): 1 to 15 bytes, not `.` or `..`, no `/`, `:` or whitespace.
		// Node writes the name of the interface a link-local peer arrived on, so a refusal here would
		// throw on a real client.
		const names = ['tun+', 'veth@1', 'br-0a1b2c3d4e5f', '7', 'réseau-maison1', 'é'.repeat(7)];
		for (const zone of names.map(asNodeWritesIt)) {
			expect(logPseudonym(`fe80::1%${zone}`)).toBe(keyed(`fe80::1%${zone}`));
		}
	});

	it('reads a no-break space around an address as one spelling, as the limiter reads it', () => {
		// parseIp trims with String.prototype.trim, so the counter takes `192.0.2.1\u00a0`; a label that
		// refused it would drop the event line of a request the limiter counted.
		expect(logPseudonym('\u00a0203.0.113.7\u00a0')).toBe(keyed('203.0.113.7'));
	});

	it('trims the whole value before reading the zone, so surrounding whitespace is one spelling', () => {
		expect(logPseudonym(' fe80::1%eth0\t')).toBe(keyed('fe80::1%eth0'));
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
		['a bracketed address', '[2001:db8::1]'],
		// The zone is an interface name or index: Linux's IFNAMSIZ is 16 bytes with the NUL
		// (include/uapi/linux/if.h), and dev_valid_name refuses `.`, `..`, `/`, `:` and whitespace.
		['a zone with a space', 'fe80::1%eth 0'],
		// Not whitespace, so only the zone check can refuse these.
		['a zone with a slash', 'fe80::1%eth/0'],
		['a zone with a colon', 'fe80::1%eth:0'],
		['a zone named `.`', 'fe80::1%.'],
		['a zone named `..`', 'fe80::1%..'],
		['a zone of sixteen characters', `fe80::1%${'a'.repeat(16)}`],
		[
			'a zone of sixteen bytes as Node would write them',
			`fe80::1%${asNodeWritesIt('é'.repeat(8))}`
		],
		['a zone with a character no byte decodes to', 'fe80::1%eth\u0100'],
		// The kernel's isspace (lib/ctype.c) counts byte 0xA0 as a space, so it refused to create an
		// interface named `wlan-à` (c3 a0), measured; a zone holding U+00A0 names no interface.
		['a zone holding byte 0xA0', `fe80::1%${asNodeWritesIt('wlan-à')}`],
		// Bytes no interface name holds, each class separately: C's other spaces, and NUL.
		['a zone holding a tab', 'fe80::1%eth\t0'],
		['a zone holding NUL', 'fe80::1%eth\u00000'],
		['a zone with a second `%`', 'fe80::1%eth0%eth1'],
		['whitespace before the zone', 'fe80::1 %eth0'],
		['a zone on an IPv4 address', '203.0.113.7%eth0'],
		['a zone on an IPv4-mapped address', '::ffff:203.0.113.7%eth0']
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

	it('refuses a value that is not a string at run time with the same reason, not a TypeError', () => {
		// A caller typed `string` can still pass undefined (an absent header read through `!`).
		expect(() => logPseudonym(undefined as unknown as string)).toThrow(/not an IP address/);
	});
});

/**
 * The subnet label (owner ruling 2026-10-08 on #869). The address pseudonym follows the full
 * address (R1), so one IPv6 subscriber rotating through the block it was given reads as many
 * sources, while the limiter counts it once. The subnet label is the limiter's bucket written as
 * CIDR text (`addressSubnet`, the prefix width included) and keyed under a key of its own, so a log
 * line names the source the limiter counted. Both fields are logged; R1's pseudonym stays.
 *
 * The exception, by design: an address the limiter counts as IPv4 (the mapped form, the NAT64
 * well-known prefix 64:ff9b::/96) carries its IPv4 client's label. That the label agrees with the
 * limiter's own counter is asserted in auth/rateLimitSubnet.spec.ts, beside the limiter's fake.
 */
describe('logSubnetPseudonym: one subscriber, one label (#869)', () => {
	// Derived per call, so a missing export fails each test rather than the whole file.
	const subnetKey = () => deriveLogSubnetKey(SECRET);
	const keyedSubnet = (cidr: string) =>
		createHmac('sha256', subnetKey()).update(cidr, 'utf8').digest('hex');
	// One /56: the first 56 bits are 2001:0db8:00aa:bb.
	const INSIDE = '2001:db8:aa:bb00::1';
	const SAME_56 = '2001:db8:aa:bbff:ffff:ffff:ffff:fffe';

	beforeEach(() => {
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		vi.stubEnv('BP_RATE_LIMIT_IPV6_PREFIX', '');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('gives two addresses of one /56 one subnet label while each keeps its own pseudonym', () => {
		expect([
			logSubnetPseudonym(INSIDE) === logSubnetPseudonym(SAME_56),
			logPseudonym(INSIDE) === logPseudonym(SAME_56)
		]).toEqual([true, false]);
	});

	// The two boundary bits of a /56: bb vs ba differ in bit 55, the last inside it.
	it('separates two addresses that differ in the last bit of the prefix', () => {
		expect(logSubnetPseudonym('2001:db8:aa:ba00::1')).not.toBe(logSubnetPseudonym(INSIDE));
	});

	// bb00 vs bb80 differ in bit 56, the first outside it.
	it('merges two addresses that differ in the first bit after the prefix', () => {
		expect(logSubnetPseudonym('2001:db8:aa:bb80::1')).toBe(logSubnetPseudonym(INSIDE));
	});

	it('gives every address inside one /56 the same label, wherever the prefix sits (property)', () => {
		const word = fc.integer({ min: 0, max: 0xffff });
		const groups = fc.array(word, { minLength: 8, maxLength: 8 });
		// Any first group but 0 (the mapped region) and 0x64 (NAT64), which fold to IPv4 by design.
		const first = word.filter((g) => g !== 0 && g !== 0x64);
		const text = (g: readonly number[]) => g.map((x) => x.toString(16)).join(':');
		fc.assert(
			fc.property(first, groups, groups, (head, a, b) => {
				const top = a[3] & 0xff00; // bits 48-55 shared, bits 56-63 drawn per address
				const one = [head, a[1], a[2], top | (a[3] & 0xff), ...a.slice(4)];
				const two = [head, a[1], a[2], top | (b[3] & 0xff), ...b.slice(4)];
				expect(logSubnetPseudonym(text(one))).toBe(logSubnetPseudonym(text(two)));
			}),
			{ seed: 869, numRuns: 500 }
		);
	});

	it('hashes the CIDR text of the bucket, prefix width included, under the subnet key', () => {
		expect(logSubnetPseudonym(INSIDE)).toBe(keyedSubnet('2001:db8:aa:bb00::/56'));
		expect(logSubnetPseudonymWith(subnetKey(), INSIDE, 64)).toBe(
			keyedSubnet('2001:db8:aa:bb00::/64')
		);
		expect(logSubnetPseudonym('203.0.113.7')).toBe(keyedSubnet('203.0.113.7/32'));
	});

	it('changes every IPv6 label when the prefix setting changes, even where the masked bits agree', () => {
		// 2001:db8:aa:bb00:: is the same masked value at /56 and at /64: only the width tells them apart.
		const at56 = logSubnetPseudonym(INSIDE);
		vi.stubEnv('BP_RATE_LIMIT_IPV6_PREFIX', '64');
		expect(logSubnetPseudonym(INSIDE)).not.toBe(at56);
	});

	it('follows BP_RATE_LIMIT_IPV6_PREFIX: at 48, two /56s of one /48 share a label', () => {
		vi.stubEnv('BP_RATE_LIMIT_IPV6_PREFIX', '48');
		expect(logSubnetPseudonym('2001:db8:aa:1200::1')).toBe(logSubnetPseudonym(INSIDE));
	});

	it('gives an address the limiter counts as IPv4 its IPv4 client label, and only those', () => {
		expect(
			new Set([
				logSubnetPseudonym('64:ff9b::c000:201'),
				logSubnetPseudonym('::ffff:192.0.2.1'),
				logSubnetPseudonym('192.0.2.1')
			]).size
		).toBe(1);
		expect(logSubnetPseudonym('64:ff9b::c000:201')).not.toBe(
			logSubnetPseudonym('64:ff9b::c000:202')
		);
		// Outside the /96 but inside 64:ff9b::/56: an ordinary IPv6 subnet.
		expect(logSubnetPseudonym('64:ff9b::1:0:1')).toBe(keyedSubnet('64:ff9b::/56'));
	});

	it('uses a key of its own: neither the address pseudonym key nor the raw secret', () => {
		// Same text under the three keys, so only the key can tell them apart.
		const cidr = '203.0.113.7/32';
		const label = logSubnetPseudonym('203.0.113.7');
		expect(LOG_SUBNET_KEY_LABEL).toBe('budgetpilot:log-subnet:v1');
		expect([
			label === createHmac('sha256', deriveLogPseudonymKey(SECRET)).update(cidr).digest('hex'),
			label === createHmac('sha256', SECRET).update(cidr).digest('hex')
		]).toEqual([false, false]);
	});

	it('never equals the address pseudonym of the same IPv4 client, so a line does not reveal the family', () => {
		expect(logSubnetPseudonym('203.0.113.7')).not.toBe(logPseudonym('203.0.113.7'));
	});

	it('gives every spelling of one address one subnet label', () => {
		expect(
			new Set([
				logSubnetPseudonym('2001:DB8:AA:BB00:0:0:0:1'),
				logSubnetPseudonym(` ${INSIDE} `),
				logSubnetPseudonym(`${INSIDE}%eth0`)
			]).size
		).toBe(1);
	});

	it.each([
		['an email address', 'paul.mercier@example.test'],
		['an empty value', ''],
		['a zone that is no interface name', 'fe80::1%eth/0'],
		['a value that is not a string', undefined as unknown as string]
	])('refuses %s rather than keying it, and does not echo it', (_label, value) => {
		// The limiter keys a non-address as its own text; the label must refuse first.
		let message = '';
		try {
			logSubnetPseudonym(value);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/not an IP address/);
		if (value) expect(message).not.toContain(value);
	});

	it('has a type of its own, so a subnet label cannot be written where the address goes', () => {
		// @ts-expect-error a subnet label is not the address pseudonym (svelte-check reads this line)
		const wrong: LogPseudonym = logSubnetPseudonym(INSIDE);
		expect(wrong).toHaveLength(64);
	});
});
