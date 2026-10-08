import { OperatorFacingError } from '$lib/server/operatorFacingError';

/**
 * Trustworthy client-IP resolution for the rate limiter.
 *
 * The rate limiter keys on the client IP, so "which IP is this request from" is a security
 * decision, not a convenience. Behind a reverse proxy the socket peer is the proxy, and the real
 * client sits in `X-Forwarded-For` (XFF), which is attacker-supplied unless a trusted proxy
 * overwrote it. `@sveltejs/adapter-node` can be told to trust XFF via `ADDRESS_HEADER`, but it
 * does so BLINDLY: it returns the header value with no check on who sent it, so anyone who can
 * reach the app port can rotate `X-Forwarded-For` and defeat the per-IP limiter (measured: 0 of 8
 * attempts blocked, #219).
 *
 * So the app resolves the client IP itself and trusts XFF only when the socket peer is on an
 * operator-configured `TRUSTED_PROXIES` allowlist. That requires `getClientAddress()` to return
 * the socket peer, which only happens when `ADDRESS_HEADER` is UNSET. `assertForwardingConfigSafe`
 * refuses to start if it is set (see there for why fail-closed is refuse-to-start here).
 *
 * FAIL CLOSED: an empty or absent `TRUSTED_PROXIES` means XFF is never trusted and the socket peer
 * is used. Trusting the header by default is the silent fail-open this module exists to remove.
 */

export interface CidrRange {
	version: 4 | 6;
	/** Network address, masked to `prefix` bits. */
	network: bigint;
	prefix: number;
}

const V4_MAX_PREFIX = 32;
const V6_MAX_PREFIX = 128;

/**
 * Parses an IP address (IPv4, IPv6, or IPv4-mapped IPv6) into a version-tagged integer.
 *
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is folded to plain IPv4, because a dual-stack Node
 * listener reports a v4 peer that way and an operator writes the allowlist in v4. Returns null on
 * anything malformed rather than throwing: this runs on request-supplied header segments.
 */
export function parseIp(raw: string): { version: 4 | 6; value: bigint } | null {
	const value = raw.trim();
	if (!value) return null;

	if (value.includes(':')) {
		const mapped = parseIpv6(value);
		if (!mapped) return null;
		// Fold an IPv4-mapped address (::ffff:a.b.c.d, the low 32 bits with the ::ffff prefix)
		// down to IPv4 so it compares against a v4 allowlist entry.
		const V4_MAPPED_PREFIX = 0xffffn << 32n;
		if (mapped >> 32n === V4_MAPPED_PREFIX >> 32n && mapped >> 48n === 0n) {
			return { version: 4, value: mapped & 0xffffffffn };
		}
		return { version: 6, value: mapped };
	}

	const v4 = parseIpv4(value);
	return v4 === null ? null : { version: 4, value: v4 };
}

/** A dotted quad from a 32-bit value. */
function formatIpv4(value: bigint): string {
	return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.');
}

/**
 * RFC 5952 section 4 text from a 128-bit value: lowercase, no leading zeros, and `::` standing for
 * the first longest run of two or more zero groups (« the first sequence of zero bits MUST be
 * shortened » when two runs are equal, and « The symbol "::" MUST NOT be used to shorten just one
 * 16-bit 0 field »).
 */
function formatIpv6(value: bigint): string {
	const groups = Array.from({ length: 8 }, (_, i) =>
		Number((value >> BigInt(112 - 16 * i)) & 0xffffn)
	);
	let runStart = -1;
	let runLength = 1;
	for (let i = 0; i < 8;) {
		if (groups[i] !== 0) {
			i += 1;
			continue;
		}
		let end = i;
		while (end < 8 && groups[end] === 0) end += 1;
		if (end - i > runLength) {
			runStart = i;
			runLength = end - i;
		}
		i = end;
	}
	const hex = groups.map((group) => group.toString(16));
	if (runStart < 0) return hex.join(':');
	return `${hex.slice(0, runStart).join(':')}::${hex.slice(runStart + runLength).join(':')}`;
}

/**
 * A zone index (RFC 4007 section 11, `<address>%<zone_id>`) as Node writes one after a link-local
 * peer: the name of the interface it arrived on, or a number. Exactly the names Linux accepts
 * (`dev_valid_name`, net/core/dev.c): 1 to 15 bytes (IFNAMSIZ is 16 with the NUL), not `.` or `..`,
 * and no `/`, `:` or whitespace in C's sense. `%` cannot occur: the caller splits on it.
 *
 * NODE WRITES ONE CHARACTER PER BYTE (Latin-1), so a byte is a character here, never a UTF-8 unit.
 * Measured on Node 24.18 with dummy interfaces in a network namespace: `réseau-maison1` (15 UTF-8
 * bytes) arrives as 15 characters, `rÃ©seau-maison1`. Counted in UTF-8 it would be 17 and refuse a
 * real client. Whitespace is the kernel's `isspace` (`_ctype`, lib/ctype.c): bytes 9 to 13, 32 and
 * 160, so the kernel refused to create `wlan-à` (c3 a0), measured the same way.
 */
function isZoneId(zone: string): boolean {
	return (
		/^[\u0001-\u00ff]{1,15}$/.test(zone) &&
		zone !== '.' &&
		zone !== '..' &&
		!/[/:\t\n\v\f\r \u00a0]/.test(zone)
	);
}

/** C's isspace in the C locale: the whitespace a peer's text or a header can carry around it. */
const ASCII_SPACE = '\t\n\v\f\r ';
const SURROUNDING_ASCII_SPACE = new RegExp(`^[${ASCII_SPACE}]+|[${ASCII_SPACE}]+$`, 'g');

/** What an address may be written with: hex digits, `:` and `.`. Anything else is not one. */
const ADDRESS_CHARACTERS = /^[0-9A-Fa-f:.]+$/;

/**
 * The one text of an address, so that every spelling of one address is one string; null for
 * anything that is not exactly one address.
 *
 * IPv4 as a dotted quad, the IPv4-mapped form folded to it as `parseIp` does; IPv6 as RFC 5952
 * section 4 writes it. RFC 5952 section 5 recommends KEEPING the mapped form as `::ffff:a.b.c.d`;
 * folding it is this module's choice (a dual-stack listener reports an IPv4 peer that way), the
 * fold Go's `netip.Addr.Unmap` and Python's `ipaddress` `ipv4_mapped` offer on request. Neither
 * the IPv4-compatible form (`::a.b.c.d`, deprecated by RFC 4291 section 2.5.5.1) nor a NAT64
 * address (RFC 6052) is folded: each names a different address, whatever `rateLimitAddressKey`
 * counts it as.
 *
 * Surrounding ASCII whitespace is trimmed; any other character outside an address refuses. A zone
 * is kept verbatim (interface names are case-sensitive; it is hashed, never logged as text) after
 * the canonical IPv6 text, and refused on IPv4 or a mapped address, where it means nothing.
 */
export function canonicalIpText(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const text = raw.replace(SURROUNDING_ASCII_SPACE, '');
	const [address, zone, ...rest] = text.split('%');
	if (rest.length > 0) return null;
	// Positive: `parseIp` trims Unicode whitespace, so the characters are checked before it reads.
	if (!ADDRESS_CHARACTERS.test(address)) return null;
	const parsed = parseIp(address);
	if (!parsed) return null;
	if (parsed.version === 4) return zone === undefined ? formatIpv4(parsed.value) : null;
	if (zone !== undefined && !isZoneId(zone)) return null;
	const canonical = formatIpv6(parsed.value);
	return zone === undefined ? canonical : `${canonical}%${zone}`;
}

function parseIpv4(value: string): bigint | null {
	const parts = value.split('.');
	if (parts.length !== 4) return null;
	let result = 0n;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		// Reject leading zeros ("01") so one textual address has one representation.
		if (part.length > 1 && part[0] === '0') return null;
		result = (result << 8n) | BigInt(octet);
	}
	return result;
}

function parseIpv6(value: string): bigint | null {
	// At most one "::" (the zero-run abbreviation).
	const doubleColon = value.split('::');
	if (doubleColon.length > 2) return null;

	const expand = (segment: string): string[] => (segment === '' ? [] : segment.split(':'));
	const head = expand(doubleColon[0]);
	const tail = doubleColon.length === 2 ? expand(doubleColon[1]) : [];

	// A trailing IPv4 (e.g. ::ffff:127.0.0.1) occupies the last two 16-bit groups.
	const lastOf = (arr: string[]) => arr[arr.length - 1];
	const embedded = doubleColon.length === 2 ? tail : head;
	if (embedded.length > 0 && lastOf(embedded).includes('.')) {
		const v4 = parseIpv4(lastOf(embedded));
		if (v4 === null) return null;
		const high = (v4 >> 16n) & 0xffffn;
		const low = v4 & 0xffffn;
		embedded.splice(embedded.length - 1, 1, high.toString(16), low.toString(16));
	}

	const groups: string[] = [];
	if (doubleColon.length === 2) {
		const missing = 8 - (head.length + tail.length);
		if (missing < 1) return null; // "::" must stand for at least one zero group
		groups.push(...head, ...Array(missing).fill('0'), ...tail);
	} else {
		groups.push(...head);
	}
	if (groups.length !== 8) return null;

	let result = 0n;
	for (const group of groups) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
		result = (result << 16n) | BigInt(parseInt(group, 16));
	}
	return result;
}

/** Parses a CIDR (`10.0.0.0/8`, `2001:db8::/32`) or a bare IP (treated as a /32 or /128). */
export function parseCidr(raw: string): CidrRange | null {
	const [addr, prefixText, ...rest] = raw.trim().split('/');
	if (rest.length > 0) return null;
	const parsed = parseIp(addr);
	if (!parsed) return null;

	const maxPrefix = parsed.version === 4 ? V4_MAX_PREFIX : V6_MAX_PREFIX;
	let prefix = maxPrefix;
	if (prefixText !== undefined) {
		if (!/^\d{1,3}$/.test(prefixText)) return null;
		prefix = Number(prefixText);
		if (prefix > maxPrefix) return null;
	}

	const hostBits = BigInt(maxPrefix - prefix);
	const mask = hostBits === 0n ? -1n : ~((1n << hostBits) - 1n);
	return { version: parsed.version, network: parsed.value & mask, prefix };
}

/** Comma-separated allowlist of IPs/CIDRs. Malformed entries are dropped, never trusted. */
export function parseTrustedProxies(raw: string | undefined): CidrRange[] {
	if (!raw?.trim()) return [];
	return raw
		.split(',')
		.map((entry) => parseCidr(entry))
		.filter((entry): entry is CidrRange => entry !== null);
}

/** True when `ip` falls inside any allowlisted range (same IP version). */
export function ipIsTrusted(ip: string, trusted: readonly CidrRange[]): boolean {
	if (trusted.length === 0) return false;
	const parsed = parseIp(ip);
	if (!parsed) return false;
	const hostBits = (r: CidrRange) =>
		BigInt((r.version === 4 ? V4_MAX_PREFIX : V6_MAX_PREFIX) - r.prefix);
	return trusted.some((range) => {
		if (range.version !== parsed.version) return false;
		const bits = hostBits(range);
		const mask = bits === 0n ? -1n : ~((1n << bits) - 1n);
		return (parsed.value & mask) === range.network;
	});
}

/** A port as a proxy writes one after an address: 1 to 65535, as nginx's `ngx_parse_addr_port`. */
function isPort(text: string): boolean {
	return /^\d{1,5}$/.test(text) && Number(text) >= 1 && Number(text) <= 65535;
}

/**
 * The address one X-Forwarded-For hop names, or null when it names none.
 *
 * Proxies write the client either bare or with the port it connected from: Azure Application
 * Gateway writes « a comma-separated list of IP:port », IIS ARR likewise. Read, in order:
 * `[ipv6]` and `[ipv6]:port` (RFC 3986's form); `a.b.c.d:port`; nine colon-separated groups whose
 * last is a port, which cannot be an address and so is an unbracketed IPv6 with its port; anything
 * else whole. docs/reverse-proxy.md asks the proxy to bracket an IPv6 address it writes a port after.
 *
 * AN UNBRACKETED IPv6 WITH `::` WHOSE LAST GROUP IS DECIMAL DIGITS MAY BE AN ADDRESS FOLLOWED BY A
 * PORT, and nothing in the text says which. Read whole, a port shifts the groups after `::` one place
 * to the left, which moves the client's interface identifier, chosen by the client, into the
 * prefix the rate limiter keys on (`rateLimitAddressKey`): `2001:db8::100:b:c:d:4431` is
 * 2001:db8:0:0:100:b:c:d with port 4431, and reads as 2001:db8:0:100:b:c:d:4431. Where the text
 * without its last group is also an address, the two readings must share their first 64 bits, the
 * longest prefix the limiter accepts, so either gives the same IPv6 key; otherwise the hop is
 * unreadable, and the walk stops at the peer as for any unreadable hop. The exception is a reading
 * `rateLimitAddressKey` folds to IPv4 (NAT64, mapped): written with a port, such a client keys on
 * the shared prefix of the whole reading, which fails closed. Both readings are returned, because
 * the walk must also ask whether each is a trusted proxy, and a hop whose readings disagree on that
 * stops the walk: an IPv6 proxy trusted as a single address can then cut an honest chain short,
 * which docs/reverse-proxy.md avoids by trusting its /64. A bare address with no port, written as
 * RFC 5952 asks (nginx, Caddy, HAProxy, Traefik), is refused only when its zero run ends before its
 * fourth group, at least two groups follow it, and its last group happens to be all digits:
 * `X:0:0:S:…`, the first /48 of a /16.
 */
function readForwardedHop(hop: string): { address: string; otherReading?: string } | null {
	const text = hop.trim();
	const bracketed = /^\[([^\]]*)\](?::(.*))?$/.exec(text);
	let address = text;
	if (bracketed) {
		if (bracketed[2] !== undefined && !isPort(bracketed[2])) return null;
		address = bracketed[1];
		if (!address.includes(':')) return null;
	} else if (text.includes('.') && text.split(':').length === 2) {
		const [v4, port] = text.split(':');
		if (!isPort(port)) return null;
		address = v4;
	} else if (text.split(':').length === 9 && !text.includes('::')) {
		const cut = text.lastIndexOf(':');
		if (!isPort(text.slice(cut + 1))) return null;
		address = text.slice(0, cut);
	} else if (text.includes('::') && /:\d{1,4}$/.test(text)) {
		const shorter = text.slice(0, text.lastIndexOf(':'));
		const whole = parseIpv6(text);
		const withoutLast = parseIpv6(shorter);
		if (whole !== null && withoutLast !== null) {
			if (whole >> 64n !== withoutLast >> 64n) return null;
			return { address, otherReading: shorter };
		}
	}
	return parseIp(address) ? { address } : null;
}

/** RFC 6052's well-known NAT64 prefix, 64:ff9b::/96: a translated IPv4 client sits in its last 32 bits. */
const NAT64_WELL_KNOWN = (0x64n << 112n) | (0xff9bn << 96n);
const ALL_128_BITS = (1n << 128n) - 1n;

/**
 * The text the rate limiter keys an address on: one subscriber, one key.
 *
 * An end site is given a whole IPv6 prefix, a /64 at the least and commonly a /56 or a /48
 * (RFC 6177; RIPE-690 recommends /56 for residential and /48 for business customers), so an IPv6
 * address keys as its first `v6PrefixBits` bits, written as `v6:` and the hex of the masked value.
 * An IPv4 address keys as itself: it is one subscriber at most. Three spellings fold to IPv4 first:
 * the mapped form (`::ffff:a.b.c.d`, folded by `parseIp`), the well-known NAT64 prefix (every IPv4
 * client behind a translator arrives inside that one /96, which a mask would make one counter), and
 * a zone (`fe80::1%eth0`, as Node reports a link-local peer) is dropped before parsing, so every
 * link-local peer, on every interface, shares the fe80:: prefix rather than holding one counter
 * per identifier.
 *
 * Numeric rather than textual, so every spelling of one address is one key. Text that is no address
 * keys as written, trimmed and lowercased: no production caller passes one (the peer comes from
 * Node, a hop through `readForwardedHop`), and test fixtures do.
 */
export function rateLimitAddressKey(address: string, v6PrefixBits: number): string {
	const subscriber = subscriberOf(address, v6PrefixBits);
	if (!subscriber) return address.trim().toLowerCase();
	if (subscriber.version === 4) return formatIpv4(subscriber.network);
	return `v6:${subscriber.network.toString(16)}`;
}

/**
 * The same subscriber as `rateLimitAddressKey` keys, written as CIDR text with its width:
 * `192.0.2.1/32`, `2001:db8:aa:bb00::/56` (RFC 4291 section 2.3's prefix notation, the address
 * part as RFC 5952 writes it). The log's subnet label hashes this text (#869), so it names the
 * bucket the limiter counts while carrying the width, which the limiter's own key does not:
 * `2001:db8:aa:bb00::` masks to the same value at /56 and /64. Null for anything not an address.
 */
export function addressSubnet(address: string, v6PrefixBits: number): string | null {
	// The canonical reading first, so this export refuses what the log labels refuse (a zone on an
	// IPv4 address, a zone that is no interface name) rather than trusting its caller to.
	const canonical = canonicalIpText(address);
	if (canonical === null) return null;
	const subscriber = subscriberOf(canonical, v6PrefixBits);
	if (!subscriber) return null;
	const network =
		subscriber.version === 4 ? formatIpv4(subscriber.network) : formatIpv6(subscriber.network);
	return `${network}/${subscriber.prefixBits}`;
}

/** The one reading of "which subscriber is this", for the limiter key and the subnet text alike. */
function subscriberOf(
	address: string,
	v6PrefixBits: number
): { version: 4 | 6; network: bigint; prefixBits: number } | null {
	const parsed = parseIp(address.replace(/%[^%]*$/, ''));
	if (!parsed) return null;
	let { version, value } = parsed;
	if (version === 6 && value >> 32n === NAT64_WELL_KNOWN >> 32n) {
		version = 4;
		value &= 0xffffffffn;
	}
	if (version === 4) return { version, network: value, prefixBits: V4_MAX_PREFIX };
	const mask = ALL_128_BITS ^ ((1n << BigInt(V6_MAX_PREFIX - v6PrefixBits)) - 1n);
	return { version, network: value & mask, prefixBits: v6PrefixBits };
}

/**
 * The real client IP for rate limiting.
 *
 * `peer` is the socket peer (from `getClientAddress()` with `ADDRESS_HEADER` unset). XFF is trusted
 * only when the peer is an allowlisted proxy; otherwise it is ignored and the peer is used. When it
 * is trusted, the client is the rightmost XFF entry that is NOT itself an allowlisted proxy, which
 * walks back through a chain of trusted proxies without an XFF-depth setting: each hop the operator
 * trusts is skipped, and the first address none of them vouches for is the client.
 *
 * FAIL CLOSED on a hop that names no address: the walk ends at the peer. Every entry left of the
 * one the proxy appended is text the client sent, so continuing past an unreadable hop would hand
 * the choice of address to the client. nginx's realip module and ASP.NET Core's
 * ForwardedHeadersMiddleware also stop at an unparsable entry; they keep the last address already
 * read, where this keeps the peer.
 */
export function resolveForwardedClientAddress(
	peer: string,
	forwardedFor: string | null,
	trusted: readonly CidrRange[]
): string {
	if (trusted.length === 0) return peer; // fail closed: never trust XFF without an allowlist
	if (!ipIsTrusted(peer, trusted)) return peer; // spoofed from a non-proxy source: ignore XFF
	if (!forwardedFor) return peer;

	const hops = forwardedFor.split(',');
	for (let i = hops.length - 1; i >= 0; i -= 1) {
		const hop = readForwardedHop(hops[i]);
		if (hop === null) return peer;
		const isProxy = ipIsTrusted(hop.address, trusted);
		// An ambiguous hop (see readForwardedHop) is a proxy only when both readings are: trusting
		// one reading would let a client whose address and port spell a trusted address skip it.
		if (hop.otherReading !== undefined && ipIsTrusted(hop.otherReading, trusted) !== isProxy) {
			return peer;
		}
		if (!isProxy) return hop.address;
	}
	return peer;
}

export const ADDRESS_HEADER_ENV = 'ADDRESS_HEADER';
export const XFF_DEPTH_ENV = 'XFF_DEPTH';
export const TRUSTED_PROXIES_ENV = 'TRUSTED_PROXIES';

// process.env does not change at runtime, so the allowlist is parsed once per distinct raw value
// rather than on every request (this is the hot path for every login/register/MFA attempt). Keyed
// on the raw string so a test that mutates the env still re-parses.
let cachedRaw: string | undefined;
let cachedParsed: CidrRange[] = [];
function getTrustedProxies(env: NodeJS.ProcessEnv): CidrRange[] {
	const raw = env[TRUSTED_PROXIES_ENV];
	if (raw !== cachedRaw) {
		cachedRaw = raw;
		cachedParsed = parseTrustedProxies(raw);
	}
	return cachedParsed;
}

/**
 * The rate-limit key for a request. The single place the five `getClientAddress()` call sites go
 * through, so the trusted-proxy rule cannot be applied to one path and forgotten on another.
 */
export function resolveClientAddress(
	source: { getClientAddress: () => string; request: Request },
	env: NodeJS.ProcessEnv = process.env
): string {
	return resolveForwardedClientAddress(
		source.getClientAddress(),
		source.request.headers.get('x-forwarded-for'),
		getTrustedProxies(env)
	);
}

/**
 * Refuses to start when `ADDRESS_HEADER`/`XFF_DEPTH` are set.
 *
 * `adapter-node` consumes `ADDRESS_HEADER` to make `getClientAddress()` return the raw forwarded
 * header, which hides the socket peer this module needs to validate the header against
 * `TRUSTED_PROXIES`. There is no way to keep running AND validate in that state, so the safe move
 * is to refuse to boot and name the migration, rather than silently key the limiter on an
 * unverifiable header (the exact fail-open #219 is about). Throw message names both variables.
 */
export function assertForwardingConfigSafe(env: NodeJS.ProcessEnv = process.env): void {
	const offenders = [ADDRESS_HEADER_ENV, XFF_DEPTH_ENV].filter(
		(name) => (env[name] ?? '').trim() !== ''
	);
	if (offenders.length === 0) return;
	throw new OperatorFacingError(
		`${offenders.join(' and ')} must not be set: this app validates X-Forwarded-For against ` +
			`${TRUSTED_PROXIES_ENV} itself, and ${ADDRESS_HEADER_ENV} makes the framework trust the ` +
			`header blindly (see #219). Unset ${ADDRESS_HEADER_ENV}/${XFF_DEPTH_ENV} and set ` +
			`${TRUSTED_PROXIES_ENV} to your proxy's address or CIDR instead. See docs/reverse-proxy.md.`
	);
}
