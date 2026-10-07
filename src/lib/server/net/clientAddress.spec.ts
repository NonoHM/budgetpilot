import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
	assertForwardingConfigSafe,
	ipIsTrusted,
	parseCidr,
	parseIp,
	parseTrustedProxies,
	resolveClientAddress,
	resolveForwardedClientAddress
} from './clientAddress';

describe('parseIp', () => {
	it('parses IPv4', () => {
		expect(parseIp('192.168.1.1')).toEqual({ version: 4, value: 0xc0a80101n });
		expect(parseIp('0.0.0.0')).toEqual({ version: 4, value: 0n });
		expect(parseIp('255.255.255.255')).toEqual({ version: 4, value: 0xffffffffn });
	});

	it('parses IPv6, including :: expansion and embedded v4', () => {
		expect(parseIp('::1')).toEqual({ version: 6, value: 1n });
		expect(parseIp('2001:db8::1')?.version).toBe(6);
		// embedded-v4 form of a real v6 address (not the ::ffff mapped form)
		expect(parseIp('2001:db8::1.2.3.4')?.version).toBe(6);
	});

	it('FOLDS IPv4-mapped IPv6 to plain IPv4 (a dual-stack peer reports v4 this way)', () => {
		expect(parseIp('::ffff:127.0.0.1')).toEqual({ version: 4, value: 0x7f000001n });
		expect(parseIp('::ffff:10.0.0.5')).toEqual({ version: 4, value: 0x0a000005n });
	});

	it('rejects malformed input rather than throwing (runs on request-supplied segments)', () => {
		for (const bad of [
			'',
			'   ',
			'999.1.1.1',
			'1.2.3',
			'1.2.3.4.5',
			'01.2.3.4', // leading zero: one address, one spelling
			'0x1.2.3.4',
			'1.2.3.-1',
			'::ffff::1', // two ::
			'gggg::1',
			'12345::1',
			'not-an-ip'
		]) {
			expect(parseIp(bad), bad).toBeNull();
		}
	});
});

describe('parseCidr', () => {
	it('parses CIDR and bare IPs, masking the network', () => {
		expect(parseCidr('10.0.0.0/8')).toEqual({ version: 4, network: 0x0a000000n, prefix: 8 });
		// host bits are masked off, so a non-network address still yields the network
		expect(parseCidr('10.5.6.7/8')).toEqual({ version: 4, network: 0x0a000000n, prefix: 8 });
		expect(parseCidr('192.168.1.4')).toEqual({ version: 4, network: 0xc0a80104n, prefix: 32 });
		expect(parseCidr('::1')).toEqual({ version: 6, network: 1n, prefix: 128 });
		expect(parseCidr('0.0.0.0/0')).toEqual({ version: 4, network: 0n, prefix: 0 });
	});

	it('rejects a bad prefix or shape', () => {
		for (const bad of [
			'1.2.3.4/33',
			'2001:db8::/129',
			'1.2.3.4/x',
			'1.2.3.4/8/8',
			'/8',
			'1.2.3.4/-1'
		]) {
			expect(parseCidr(bad), bad).toBeNull();
		}
	});
});

describe('ipIsTrusted', () => {
	it('matches inside a range and rejects outside it', () => {
		const t = parseTrustedProxies('10.0.0.0/8, 192.168.1.0/24');
		expect(ipIsTrusted('10.5.6.7', t)).toBe(true);
		expect(ipIsTrusted('192.168.1.255', t)).toBe(true);
		expect(ipIsTrusted('192.168.2.0', t)).toBe(false);
		expect(ipIsTrusted('11.0.0.1', t)).toBe(false);
	});

	it('the v4-mapped-v6 peer against a v4 CIDR (the case that silently breaks a naive matcher)', () => {
		const t = parseTrustedProxies('10.0.0.0/8');
		expect(ipIsTrusted('::ffff:10.0.0.5', t)).toBe(true);
		expect(ipIsTrusted('::ffff:11.0.0.5', t)).toBe(false);
	});

	it('/0 matches everything of its family; /32 and /128 are exact', () => {
		expect(ipIsTrusted('8.8.8.8', parseTrustedProxies('0.0.0.0/0'))).toBe(true);
		expect(ipIsTrusted('1.2.3.4', parseTrustedProxies('1.2.3.4/32'))).toBe(true);
		expect(ipIsTrusted('1.2.3.5', parseTrustedProxies('1.2.3.4/32'))).toBe(false);
		expect(ipIsTrusted('::1', parseTrustedProxies('::1/128'))).toBe(true);
		expect(ipIsTrusted('::2', parseTrustedProxies('::1/128'))).toBe(false);
	});

	it('never matches across IP versions', () => {
		expect(ipIsTrusted('::1', parseTrustedProxies('0.0.0.0/0'))).toBe(false);
		expect(ipIsTrusted('1.2.3.4', parseTrustedProxies('::/0'))).toBe(false);
	});

	it('drops a malformed allowlist entry rather than trusting it, and an empty allowlist trusts nothing', () => {
		const t = parseTrustedProxies('garbage, 10.0.0.0/8, 1.2.3.4/99');
		expect(t).toHaveLength(1); // only 10.0.0.0/8 survived
		expect(ipIsTrusted('10.0.0.1', t)).toBe(true);
		expect(ipIsTrusted('1.2.3.4', parseTrustedProxies(''))).toBe(false);
		expect(ipIsTrusted('1.2.3.4', parseTrustedProxies(undefined))).toBe(false);
	});
});

describe('resolveForwardedClientAddress', () => {
	const trusted = parseTrustedProxies('10.0.0.0/8');

	it('FAIL CLOSED: empty allowlist ignores X-Forwarded-For and uses the peer', () => {
		expect(resolveForwardedClientAddress('10.0.0.1', '1.2.3.4', [])).toBe('10.0.0.1');
	});

	it('a peer that is not an allowlisted proxy: X-Forwarded-For is ignored entirely', () => {
		// the spoof-from-a-direct-connection case: attacker sets the header, peer is not a proxy
		expect(resolveForwardedClientAddress('203.0.113.9', '1.2.3.4', trusted)).toBe('203.0.113.9');
	});

	it('a trusted proxy peer: the client is the rightmost NON-trusted hop, so a spoofed left entry is ignored', () => {
		// client sent "6.6.6.6" then the trusted proxy appended what it actually saw
		expect(resolveForwardedClientAddress('10.0.0.1', '6.6.6.6, 203.0.113.5', trusted)).toBe(
			'203.0.113.5'
		);
		// single honest hop
		expect(resolveForwardedClientAddress('10.0.0.1', '203.0.113.5', trusted)).toBe('203.0.113.5');
	});

	it('walks back through a chain of trusted proxies to the real client', () => {
		// realclient, proxy1(trusted), proxy2(trusted); peer is a trusted proxy
		expect(
			resolveForwardedClientAddress('10.0.0.1', '203.0.113.5, 10.0.0.2, 10.0.0.3', trusted)
		).toBe('203.0.113.5');
	});

	it('falls back to the peer when the header is absent or all hops are trusted or malformed', () => {
		expect(resolveForwardedClientAddress('10.0.0.1', null, trusted)).toBe('10.0.0.1');
		expect(resolveForwardedClientAddress('10.0.0.1', '10.0.0.2, 10.0.0.3', trusted)).toBe(
			'10.0.0.1'
		);
		expect(resolveForwardedClientAddress('10.0.0.1', 'garbage, also-garbage', trusted)).toBe(
			'10.0.0.1'
		);
	});

	it('reads a hop the proxy wrote with its port as the address before the port', () => {
		// Azure Application Gateway writes « a comma-separated list of IP:port », IIS ARR likewise.
		expect(
			[
				'6.6.6.6, 203.0.113.5:51234',
				'6.6.6.6, [2001:db8::5]:51234',
				'6.6.6.6, [2001:db8::5]',
				'6.6.6.6, 203.0.113.5:1, 10.0.0.2:2'
			].map((header) => resolveForwardedClientAddress('10.0.0.1', header, trusted))
		).toEqual(['203.0.113.5', '2001:db8::5', '2001:db8::5', '203.0.113.5']);
	});

	it('FAIL CLOSED: a hop that does not parse stops the walk at the peer, never at a hop to its left', () => {
		// Everything left of the hop the proxy wrote is the client's own text, so skipping an
		// unreadable hop would hand the choice of address to the client.
		expect(
			[
				'203.0.113.5, junk',
				'6.6.6.6, 203.0.113.5:99999',
				'6.6.6.6, 203.0.113.5:',
				'6.6.6.6, [2001:db8::5',
				'6.6.6.6, 2001:db8::5:51234',
				'6.6.6.6, 203.0.113.5:51234:1',
				// Port 0 is no source port; nginx's ngx_parse_addr_port refuses it too.
				'6.6.6.6, 203.0.113.5:0',
				'6.6.6.6, [2001:db8::5]:99999',
				'6.6.6.6, [2001:db8::5]:http',
				// Brackets hold an IPv6 literal only (RFC 3986 section 3.2.2).
				'6.6.6.6, [203.0.113.5]'
			].map((header) => resolveForwardedClientAddress('10.0.0.1', header, trusted))
		).toEqual(Array(10).fill('10.0.0.1'));
	});

	it('an unreadable value the client wrote to the left is never reached', () => {
		expect(resolveForwardedClientAddress('10.0.0.1', 'junk, 203.0.113.5', trusted)).toBe(
			'203.0.113.5'
		);
	});

	it('the walk never passes the hop the proxy appended into the text before it (property)', () => {
		// Addresses from the documentation ranges, none inside the 10.0.0.0/8 allowlist, so the
		// generator does not ask the code under test which addresses are trusted.
		const host = fc.integer({ min: 1, max: 254 });
		const outside = fc.oneof(
			host.map((h) => `203.0.113.${h}`),
			host.map((h) => `198.51.100.${h}`)
		);
		const port = fc.integer({ min: 1, max: 65535 });
		// What the proxy appends: the address it saw, with or without its port; or, when it is
		// misconfigured, something unreadable, in which case the peer is the answer.
		const appended = fc.oneof(
			outside.map((ip) => ({ hop: ip, expected: ip })),
			fc.tuple(outside, port).map(([ip, p]) => ({ hop: `${ip}:${p}`, expected: ip })),
			fc.constantFrom('junk', 'unknown', '').map((hop) => ({ hop, expected: '10.0.0.1' }))
		);
		// 6.6.6.6 sits between the client's text and the proxy's hop: a walk that skipped an
		// unreadable hop would land on it, which a random prefix almost never offers.
		fc.assert(
			fc.property(fc.string({ maxLength: 40 }), appended, (prefix, { hop, expected }) => {
				const header = `${prefix}, 6.6.6.6, ${hop}`;
				expect(resolveForwardedClientAddress('10.0.0.1', header, trusted)).toBe(expected);
			}),
			{ seed: 7239, numRuns: 2000 }
		);
	});

	it('reads a nine-group hop as an IPv6 address with its port, the one unbracketed form that is not ambiguous', () => {
		// Eight groups or fewer with a trailing port read as an address (RFC 3986 asks the proxy to
		// bracket); nine cannot be an address, so the last group is the port when it is one.
		expect(
			[
				'6.6.6.6, 2001:db8:1:2:3:4:5:6:51234',
				'6.6.6.6, 2001:db8:1:2:3:4:5:6:0',
				'6.6.6.6, 2001:db8:1:2:3:4:5:6:7:8',
				// Nine parts with `::` is not this form: read whole it is 0:3:4:5:6:7:8:9, and it may also
				// be ::3:4:5:6:7:8 with port 9. The two readings disagree on the first 64 bits, so it is
				// unreadable (the next test but one).
				'6.6.6.6, ::3:4:5:6:7:8:9'
			].map((header) => resolveForwardedClientAddress('10.0.0.1', header, trusted))
		).toEqual(['2001:db8:1:2:3:4:5:6', '10.0.0.1', '10.0.0.1', '10.0.0.1']);
	});

	// Separates « an ambiguous hop is read as written » from « it is read only where its two
	// readings agree on the first 64 bits ». Written by a proxy that appends a port without
	// brackets, `2001:db8::100:b:c:d:4431` is 2001:db8:0:0:100:b:c:d with port 4431, but reads as
	// 2001:db8:0:100:b:c:d:4431, which moves the client's interface identifier into its prefix.
	it('an unbracketed hop that may end in a port is unreadable where its readings disagree on the prefix', () => {
		expect(
			[
				'6.6.6.6, 2001:db8::100:b:c:d:4431',
				'6.6.6.6, 2001:db8::100:b:c:d:0',
				'6.6.6.6, 2001::5600:100:b:c:d:4431',
				// The readings differ only in bits 56 to 63 (0:ff against 0:0), inside the /64 the
				// setting may be raised to and outside the default /56: separates comparing the first 64
				// bits from comparing the first 56.
				'6.6.6.6, 2001:db8::ff:b:c:d:4431'
			].map((header) => resolveForwardedClientAddress('10.0.0.1', header, trusted))
		).toEqual(Array(4).fill('10.0.0.1'));
	});

	// The calibration of the refusal above: where the two readings share their first 64 bits, the
	// hop is read as written, so a proxy writing bare addresses (nginx, Caddy, HAProxy, Traefik)
	// loses no client to the peer. The last spelling ends in a hex letter, which no port does.
	it('an unbracketed hop whose readings agree on the prefix is read as written', () => {
		expect(
			[
				'6.6.6.6, 2001:db8:0:5600::1:2',
				'6.6.6.6, 2001:db8::5:1',
				'6.6.6.6, 64:ff9b::c633:6407',
				'6.6.6.6, 2001:db8::100:b:c:d:abcd'
			].map((header) => resolveForwardedClientAddress('10.0.0.1', header, trusted))
		).toEqual([
			'2001:db8:0:5600::1:2',
			'2001:db8::5:1',
			'64:ff9b::c633:6407',
			'2001:db8::100:b:c:d:abcd'
		]);
	});

	it('the entry point every route calls applies the same reading', () => {
		const request = new Request('http://app.example.test/login', {
			headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.5:51234' }
		});
		const env = { TRUSTED_PROXIES: '10.0.0.0/8' } as NodeJS.ProcessEnv;
		expect(resolveClientAddress({ getClientAddress: () => '10.0.0.1', request }, env)).toBe(
			'203.0.113.5'
		);
	});
});

describe('assertForwardingConfigSafe', () => {
	afterEach(() => {
		delete process.env.ADDRESS_HEADER;
		delete process.env.XFF_DEPTH;
	});

	it('passes when neither ADDRESS_HEADER nor XFF_DEPTH is set', () => {
		expect(() => assertForwardingConfigSafe({})).not.toThrow();
		expect(() => assertForwardingConfigSafe({ ADDRESS_HEADER: '', XFF_DEPTH: '  ' })).not.toThrow();
	});

	it('refuses to start when ADDRESS_HEADER is set, naming the migration', () => {
		expect(() => assertForwardingConfigSafe({ ADDRESS_HEADER: 'X-Forwarded-For' })).toThrow(
			/ADDRESS_HEADER.*TRUSTED_PROXIES/s
		);
	});

	it('refuses to start when XFF_DEPTH is set', () => {
		expect(() => assertForwardingConfigSafe({ XFF_DEPTH: '1' })).toThrow(/XFF_DEPTH/);
	});
});
