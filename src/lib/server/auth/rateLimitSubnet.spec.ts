import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
	process.env.RATE_LIMIT_HASH_SECRET ??= 'a1'.repeat(32);
});

const db = vi.hoisted(() => ({
	prisma: {
		loginAttempt: {
			count: vi.fn(),
			create: vi.fn(),
			deleteMany: vi.fn()
		}
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const limiter = await import('./rateLimit');
const { parseTrustedProxies, resolveClientAddress, resolveForwardedClientAddress } =
	await import('$lib/server/net/clientAddress');

/**
 * THE ADDRESS COUNTER KEYS AN IPv6 CLIENT BY ITS /56, NOT BY ITS FULL ADDRESS.
 *
 * An end site is given a whole IPv6 prefix, never one address: a /64 at the least and commonly a
 * /56 or a /48, and every address inside it is the same subscriber. Keyed on the full address, one
 * subscriber holds 2^64 or more counters and the per-address limit never trips. These tests pin
 * the key as the /56 by its two boundary bits: bit 56 (the first outside the prefix, where a /56
 * key and a /57 key disagree) must NOT separate two addresses, and bit 55 (the last inside, where
 * a /55 key and a /56 key disagree) must.
 *
 * Each kind that counts the address is driven through its own exported pair, because the kinds
 * reach the key through different call sites and a loop asserting one value would not say which.
 */
type AddressKeyed = {
	/** Only called for the key it reads: a trip answer for the five authentication kinds, a boolean for the rest. */
	check: (ip: string) => Promise<unknown>;
	record: (ip: string) => Promise<void>;
};

const ADDRESS_KEYED: Record<string, AddressKeyed> = {
	LOGIN: {
		check: (ip) => limiter.isLoginRateLimited('user@example.test', ip),
		record: (ip) => limiter.recordFailedLoginAttempt('user@example.test', ip)
	},
	REGISTER: {
		check: (ip) => limiter.isRegisterRateLimited(ip),
		record: (ip) => limiter.recordRegisterAttempt(ip)
	},
	INVITE: {
		check: (ip) => limiter.isInviteRateLimited(ip),
		record: (ip) => limiter.recordInviteAttempt(ip)
	},
	MFA: {
		check: (ip) => limiter.isMfaRateLimited('challenge-1', ip),
		record: (ip) => limiter.recordMfaAttempt('challenge-1', ip)
	},
	BANK_SYNC_START: {
		check: (ip) => limiter.isBankSyncStartRateLimited('user-1', ip),
		record: (ip) => limiter.recordBankSyncStartAttempt('user-1', ip)
	},
	IMPORT: {
		check: (ip) => limiter.isImportRateLimited('user-1', ip),
		record: (ip) => limiter.recordImportAttempt('user-1', ip)
	}
};

const KINDS = Object.keys(ADDRESS_KEYED);

/** The address hash a check COUNTS against. Found by its column, never by call order. */
async function queriedIpHash(kind: string, ip: string): Promise<string> {
	db.prisma.loginAttempt.count.mockClear();
	await ADDRESS_KEYED[kind].check(ip);
	const wheres = db.prisma.loginAttempt.count.mock.calls.map((call) => call[0].where);
	const withAddress = wheres.filter((where) => where.ipHash !== undefined);
	expect(withAddress).toHaveLength(1);
	return withAddress[0].ipHash;
}

/** The address hash a record WRITES, which must be the one the check counts. */
async function recordedIpHash(kind: string, ip: string): Promise<string> {
	db.prisma.loginAttempt.create.mockClear();
	await ADDRESS_KEYED[kind].record(ip);
	expect(db.prisma.loginAttempt.create).toHaveBeenCalledTimes(1);
	return db.prisma.loginAttempt.create.mock.calls[0][0].data.ipHash;
}

beforeEach(() => {
	vi.clearAllMocks();
	db.prisma.loginAttempt.count.mockResolvedValue(0);
	db.prisma.loginAttempt.create.mockResolvedValue({});
	db.prisma.loginAttempt.deleteMany.mockResolvedValue({ count: 0 });
});

describe('the address counter keys an IPv6 client by its /56', () => {
	// Separates a /56 key from a full-address key and from a /57 key: the two addresses differ in
	// bit 56 (0x5600 against 0x5680 in the fourth group) and in every bit after it.
	it.each(KINDS)('%s: two addresses inside one /56 are counted as one client', async (kind) => {
		const first = '2001:db8:0:5600::1';
		const second = '2001:db8:0:5680:abcd:ef01:2345:6789';
		expect(await queriedIpHash(kind, second)).toBe(await queriedIpHash(kind, first));
		expect(await recordedIpHash(kind, second)).toBe(await recordedIpHash(kind, first));
		// The row written is the row counted: a record keyed one way and a check keyed another
		// would each pass the line above and never meet.
		expect(await recordedIpHash(kind, first)).toBe(await queriedIpHash(kind, first));
	});

	// Separates a /56 key from a /55 or shorter one: the two addresses differ ONLY in bit 55
	// (0x5600 against 0x5700), the last bit inside the prefix.
	it.each(KINDS)('%s: neighbouring /56 networks keep separate counters', async (kind) => {
		expect(await queriedIpHash(kind, '2001:db8:0:5700::1')).not.toBe(
			await queriedIpHash(kind, '2001:db8:0:5600::1')
		);
	});
});

describe('an address has one counter however it is written', () => {
	// Separates stripping the zone from keying the text whole: Node reports a link-local peer as
	// `fe80::<id>%<interface>`, which `parseIp` refuses, and a text key gives every interface
	// identifier on the segment its own counter. Reachable when the app listens on IPv6.
	it('link-local peers on one interface share a counter, whatever identifier they pick', async () => {
		expect(await queriedIpHash('REGISTER', 'fe80::abcd:1234%eth0')).toBe(
			await queriedIpHash('REGISTER', 'fe80::1%eth0')
		);
	});

	// Separates dropping the zone from keying it: the zone names the server's own interface, not
	// the client, so link-local peers on every interface share the one fe80:: prefix.
	it('the zone is dropped, not keyed: every interface shares the link-local counter', async () => {
		expect(await queriedIpHash('REGISTER', 'fe80::1%eth1')).toBe(
			await queriedIpHash('REGISTER', 'fe80::1%eth0')
		);
	});

	// Separates folding the well-known NAT64 prefix (RFC 6052, 64:ff9b::/96) from masking it: behind
	// a translator every IPv4 client arrives inside that one /96, and a /56 of it is one counter for
	// all of them, where each had its own before.
	it('an IPv4 client behind the well-known NAT64 prefix keeps its IPv4 counter', async () => {
		expect(await queriedIpHash('REGISTER', '64:ff9b::c633:6407')).toBe(
			await queriedIpHash('REGISTER', '198.51.100.7')
		);
		expect(await queriedIpHash('REGISTER', '64:ff9b::198.51.100.6')).toBe(
			await queriedIpHash('REGISTER', '198.51.100.6')
		);
	});

	// Separates folding the well-known /96 from folding a wider prefix: 64:ff9b:1::/48 (RFC 8215) is
	// for local translators with their own embedding, and keys as an IPv6 prefix like any other.
	it('the local-use NAT64 prefix 64:ff9b:1::/48 is not folded', async () => {
		expect(await queriedIpHash('REGISTER', '64:ff9b:1::c633:6407')).not.toBe(
			await queriedIpHash('REGISTER', '198.51.100.7')
		);
	});

	// Separates a numeric key from a textual one. A proxy and the socket can spell one address
	// differently, and a textual key would give the client one counter per spelling.
	it('the spellings of one IPv6 address share a counter', async () => {
		const spellings = [
			'2001:db8::1',
			'2001:DB8::1',
			'2001:0db8:0000:0000:0000:0000:0000:0001',
			'2001:db8:0:0::1'
		];
		const hashes = new Set<string>();
		for (const spelling of spellings) hashes.add(await queriedIpHash('REGISTER', spelling));
		expect(spellings).toHaveLength(4);
		expect(hashes.size).toBe(1);
	});

	// Separates folding the IPv4-mapped form from keying it as an IPv6 address in ::ffff:0:0/96,
	// which a dual-stack listener reports for a v4 client.
	it('an IPv4-mapped IPv6 address shares the counter of its IPv4 address', async () => {
		expect(await queriedIpHash('REGISTER', '::ffff:198.51.100.7')).toBe(
			await queriedIpHash('REGISTER', '198.51.100.7')
		);
	});

	// Separates « IPv6 grouped by prefix » from « every address grouped by prefix »: an IPv4
	// address is one subscriber at most, so two addresses one bit apart stay two counters.
	it.each(KINDS)('%s: two IPv4 addresses one bit apart keep separate counters', async (kind) => {
		expect(await queriedIpHash(kind, '198.51.100.7')).not.toBe(
			await queriedIpHash(kind, '198.51.100.6')
		);
	});
});

/**
 * AN UNBRACKETED IPv6 HOP WITH A PORT CANNOT SHIFT THE CLIENT'S OWN BITS INTO THE KEY.
 *
 * `readForwardedHop` reads `2001:db8::a:b:c:d:4431` as an address, because eight groups or fewer
 * with `::` cannot be told from an address followed by a port. When the proxy appended a port, the
 * reading is shifted by one group: the `::` stands for one zero group fewer, and the client's
 * interface identifier, which the client chooses, moves into the fourth group, inside the /56. A
 * client choosing a source port below 10000 makes the port read as a group, so this is
 * reachable behind any trusted proxy that writes an unbracketed IPv6 with its port.
 *
 * Such a hop is unreadable where its two readings (as written, and without its last group) disagree
 * on the first 64 bits, and the walk stops at the proxy, as it does for every unreadable hop. Where
 * they agree, either reading gives the same key at any prefix the setting accepts.
 *
 * Driven through `resolveClientAddress`, the function every route calls before the limiter, with
 * the peer on the trusted list exactly as a proxy deployment has it.
 */
describe('a forwarded hop read with its port shifted in', () => {
	const PROXY = '10.0.0.1';
	const env = { TRUSTED_PROXIES: PROXY } as NodeJS.ProcessEnv;

	function routeAddress(forwardedFor: string): string {
		return resolveClientAddress(
			{
				getClientAddress: () => PROXY,
				request: new Request('http://example.test/register', {
					headers: { 'x-forwarded-for': forwardedFor }
				})
			},
			env
		);
	}

	/** Every first interface-identifier group whose high byte reaches the /56 when shifted. */
	const FIRST_GROUPS = Array.from({ length: 255 }, (_, i) => ((i + 1) << 8).toString(16));

	// Separates refusing a hop whose readings disagree on the prefix from keying the shifted
	// reading, which lets the client pick 255 counters by picking its interface identifier.
	it('a client in 2001:db8::/64 holds one counter whatever interface identifier it picks', async () => {
		const hashes = new Set<string>();
		for (const group of FIRST_GROUPS) {
			hashes.add(await queriedIpHash('REGISTER', routeAddress(`2001:db8::${group}:b:c:d:4431`)));
		}
		expect(FIRST_GROUPS).toHaveLength(255);
		expect(hashes.size).toBe(1);
		// The one counter is the proxy's: the hop was unreadable and the walk stopped at the peer.
		expect([...hashes][0]).toBe(await queriedIpHash('REGISTER', PROXY));
	});

	// Separates a condition on « a group of decimal digits » from one on « a port of at least 1 »:
	// port 0 shifts the reading exactly as any other.
	it('the same holds when the port written is 0', async () => {
		const hashes = new Set<string>();
		for (const group of FIRST_GROUPS) {
			hashes.add(await queriedIpHash('REGISTER', routeAddress(`2001:db8::${group}:b:c:d:0`)));
		}
		expect(FIRST_GROUPS).toHaveLength(255);
		expect(hashes.size).toBe(1);
	});

	// Separates the same from a key that only holds when the zero run reaches the fourth group:
	// here the run is groups one and two, so the shifted reading moves the fourth group too.
	it('a client in 2001:0:0:5600::/64 holds one counter whatever interface identifier it picks', async () => {
		const hashes = new Set<string>();
		for (const group of FIRST_GROUPS) {
			hashes.add(await queriedIpHash('REGISTER', routeAddress(`2001::5600:${group}:b:c:d:4431`)));
		}
		expect(FIRST_GROUPS).toHaveLength(255);
		expect(hashes.size).toBe(1);
	});

	// Separates « an ambiguous spelling loses only the bits it cannot vouch for » from « an
	// ambiguous spelling is grouped coarsely »: a proxy writing a bare address with no port (nginx,
	// Caddy, HAProxy, Traefik) produces this spelling for an ordinary client, and that client keeps
	// its own /56.
	it('a bare address whose last group could be a port keeps its own /56', async () => {
		const bare = routeAddress('2001:db8:0:5600::1:2');
		expect(await queriedIpHash('REGISTER', bare)).toBe(
			await queriedIpHash('REGISTER', routeAddress('[2001:db8:0:5600::1]'))
		);
		expect(await queriedIpHash('REGISTER', bare)).not.toBe(
			await queriedIpHash('REGISTER', routeAddress('2001:db8:0:5700::1:2'))
		);
	});
});

/**
 * THE PREFIX IS AN OPERATOR SETTING, `BP_RATE_LIMIT_IPV6_PREFIX`: default 56, accepted 32 to 64,
 * anything else refused at startup (ruled 2026-10-07). Above 64, one subscriber's /64 would hold
 * more than one counter again; the comparables accept the same range (express-rate-limit logs an
 * out-of-range value and uses it, Nextcloud clamps it), where this refuses it.
 *
 * Read per call, as the import limit is, so these tests set it with `vi.stubEnv`.
 */
describe('the prefix is the operator setting BP_RATE_LIMIT_IPV6_PREFIX', () => {
	const SETTING = 'BP_RATE_LIMIT_IPV6_PREFIX';

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// Separates « the limiter reads the setting » from « the limiter keeps /56 whatever is set »:
	// the two addresses differ only in bit 63, inside a /64 and outside a /56.
	it('at 64, two networks of one /56 keep separate counters', async () => {
		vi.stubEnv(SETTING, '64');
		expect(await queriedIpHash('LOGIN', '2001:db8:0:5601::1')).not.toBe(
			await queriedIpHash('LOGIN', '2001:db8:0:5600::1')
		);
	});

	// Separates a /64 from a /65 or longer: the addresses differ in bit 64, the first outside.
	it('at 64, two addresses of one /64 share a counter', async () => {
		vi.stubEnv(SETTING, '64');
		expect(await queriedIpHash('LOGIN', '2001:db8:0:5600:8000::1')).toBe(
			await queriedIpHash('LOGIN', '2001:db8:0:5600::1')
		);
	});

	// Separates a configured /48 from the default /56 on the bit where they disagree (bit 55).
	it('at 48, neighbouring /56 networks share a counter', async () => {
		vi.stubEnv(SETTING, '48');
		expect(await queriedIpHash('LOGIN', '2001:db8:0:5700::1')).toBe(
			await queriedIpHash('LOGIN', '2001:db8:0:5600::1')
		);
	});

	async function startupProblemFor(value: string): Promise<string | undefined> {
		const { ENVIRONMENT_CHECKS, collectEnvironmentProblems } =
			await import('$lib/server/env/assertConfigured');
		const registered = ENVIRONMENT_CHECKS.filter(([label]) => label === SETTING);
		expect(registered).toHaveLength(1);
		vi.stubEnv(SETTING, value);
		const [problem] = await collectEnvironmentProblems(registered);
		return problem;
	}

	// Separates refusing from clamping or ignoring: 65 is the one value past the ceiling, where a
	// clamp would read 64 and start.
	it('refuses 65 at startup, naming the ceiling', async () => {
		expect(await startupProblemFor('65')).toMatch(
			/^BP_RATE_LIMIT_IPV6_PREFIX=65 is above the ceiling of 64\. /
		);
	});

	// The same at the floor: 31 is the one value below it.
	it('refuses 31 at startup, naming the minimum', async () => {
		expect(await startupProblemFor('31')).toMatch(
			/^BP_RATE_LIMIT_IPV6_PREFIX=31 is below the minimum of 32\. /
		);
	});

	// The calibration of the two refusals: the bounds themselves start.
	it('starts at 32 and at 64', async () => {
		expect(await startupProblemFor('32')).toBeUndefined();
		expect(await startupProblemFor('64')).toBeUndefined();
	});
});

/**
 * THE LOG'S SUBNET LABEL NAMES THE BUCKET THIS LIMITER COUNTS (#869, owner ruling 2026-10-08).
 *
 * Two code paths turn an address into "its subscriber": the counter's `ipHash` here and the log's
 * `logSubnetPseudonym`. A duplicated predicate passes on its own and fails apart, so the two
 * EQUALITY RELATIONS are compared over pairs that distinguish the candidate rules: the two boundary
 * bits of each width, a pair in the same /48 but not the same /56, and the regions the limiter folds
 * to IPv4 (mapped, NAT64) beside one just outside the NAT64 /96. Observed through what the check
 * queries, never by recomputing the key.
 */
describe('the log subnet label agrees with the counter at every width', () => {
	const PAIRS: [string, string][] = [
		['2001:db8:aa:bb00::1', '2001:db8:aa:ba00::1'], // bit 55
		['2001:db8:aa:bb00::1', '2001:db8:aa:bb80::1'], // bit 56
		['2001:db8:aa:bb00::1', '2001:db8:aa:bb01::1'], // bit 63
		['2001:db8:aa:bb00::1', '2001:db8:aa:bb00:8000::1'], // bit 64
		['2001:db8:aa:bb00::1', '2001:db8:aa:1200::1'], // same /48, another /56
		['2001:db8:aa:bb00::1', '2001:db8:ab:bb00::1'], // bit 47
		['64:ff9b::c000:201', '192.0.2.1'], // NAT64 and its IPv4 client
		['::ffff:192.0.2.1', '192.0.2.1'], // mapped and its IPv4 client
		['64:ff9b::c000:201', '64:ff9b::c000:202'], // two NAT64 clients
		['64:ff9b::1:0:1', '64:ff9b::1:0:2'], // outside the /96, one /56
		// The two paths read different text: the label the canonical reading, the counter the raw
		// value. These pairs differ only in what that reading changes.
		['fe80::1%eth0', 'fe80::2%eth1'], // zones on two links, one /56
		[' 2001:db8:aa:bb00::1\t', '2001:db8:aa:bb00::1'], // surrounding whitespace
		['::ffff:192.0.2.1', ' 192.0.2.1'], // mapped against padded IPv4
		// A zone as Node writes a non-ASCII interface name (Latin-1 of its bytes, measured).
		[`fe80::1%${Buffer.from('réseau-maison1', 'utf8').toString('latin1')}`, 'fe80::1'],
		// A no-break space: a header arrives Latin-1, and U+00A0 is the space beyond ASCII parseIp trims.
		['192.0.2.1\u00a0', '192.0.2.1'],
		['\u00a02001:db8:aa:bb00::1', '2001:db8:aa:bb00::1']
	];

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each(['32', '48', '56', '64'])(
		'at %s bits, one counter exactly when one label',
		async (bits) => {
			vi.stubEnv('BP_RATE_LIMIT_IPV6_PREFIX', bits);
			const { logSubnetPseudonym } = await import('$lib/server/logging/pseudonym');
			const relations = [];
			for (const [a, b] of PAIRS) {
				const counter = (await queriedIpHash('LOGIN', a)) === (await queriedIpHash('LOGIN', b));
				const label = logSubnetPseudonym(a) === logSubnetPseudonym(b);
				relations.push(`${a} ~ ${b}: counter ${counter}, label ${label}`);
			}
			// Each pair printed whole, so a red names the pair that disagreed.
			expect(relations).toEqual(
				relations.map((line) =>
					line.replace(/label (true|false)$/, `label ${/counter true/.test(line)}`)
				)
			);
		}
	);
});

/**
 * THE LABELS ACCEPT EVERY ADDRESS THE COUNTER COUNTS, as the hop reader hands it over (#869, the
 * fresh pass on the zone fix). The agreement above compares values both sides accept; this asks the
 * producer. `readForwardedHop` trims a hop's outer edge only, so a no-break space inside brackets
 * or before a port reaches both sides. If the counter counts it and a label refuses it, the event
 * line of a counted request goes missing.
 */
describe('the log labels take what the hop reader hands the counter', () => {
	const trusted = parseTrustedProxies('10.0.0.1');
	it.each([
		['before a port', '192.0.2.1\u00a0:80', '192.0.2.1'],
		['inside brackets', '[\u00a02001:db8::1]', '2001:db8::1'],
		['before the port of a bracketed address', '[2001:db8::1\u00a0]:443', '2001:db8::1'],
		['before the port of nine groups', '2001:db8:1:2:3:4:5:6\u00a0:80', '2001:db8:1:2:3:4:5:6']
	])('a no-break space %s', async (_label, hop, bare) => {
		const resolved = resolveForwardedClientAddress('10.0.0.1', hop, trusted);
		const { logPseudonym, logSubnetPseudonym } = await import('$lib/server/logging/pseudonym');
		expect([
			// The hop reader really handed over the padded text, so the labels' own trim is exercised.
			resolved !== bare,
			(await queriedIpHash('LOGIN', resolved)) === (await queriedIpHash('LOGIN', bare)),
			logPseudonym(resolved) === logPseudonym(bare),
			logSubnetPseudonym(resolved) === logSubnetPseudonym(bare)
		]).toEqual([true, true, true, true]);
	});
});
