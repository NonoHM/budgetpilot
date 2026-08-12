import { afterEach, describe, expect, it } from 'vitest';
import {
	assertForwardingConfigSafe,
	ipIsTrusted,
	parseCidr,
	parseIp,
	parseTrustedProxies,
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

	it('skips a malformed segment but still returns a valid client to its left', () => {
		expect(resolveForwardedClientAddress('10.0.0.1', '203.0.113.5, junk', trusted)).toBe(
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
