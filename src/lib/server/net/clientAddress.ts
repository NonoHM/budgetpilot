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

/**
 * The real client IP for rate limiting.
 *
 * `peer` is the socket peer (from `getClientAddress()` with `ADDRESS_HEADER` unset). XFF is trusted
 * only when the peer is an allowlisted proxy; otherwise it is ignored and the peer is used. When it
 * is trusted, the client is the rightmost XFF entry that is NOT itself an allowlisted proxy, which
 * walks back through a chain of trusted proxies without an XFF-depth setting: each hop the operator
 * trusts is skipped, and the first address none of them vouches for is the client.
 */
export function resolveForwardedClientAddress(
	peer: string,
	forwardedFor: string | null,
	trusted: readonly CidrRange[]
): string {
	if (trusted.length === 0) return peer; // fail closed: never trust XFF without an allowlist
	if (!ipIsTrusted(peer, trusted)) return peer; // spoofed from a non-proxy source: ignore XFF
	if (!forwardedFor) return peer;

	const hops = forwardedFor
		.split(',')
		.map((hop) => hop.trim())
		.filter(Boolean);
	for (let i = hops.length - 1; i >= 0; i -= 1) {
		const hop = hops[i];
		if (!parseIp(hop)) continue; // skip a malformed segment rather than key on garbage
		if (!ipIsTrusted(hop, trusted)) return hop;
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
	throw new Error(
		`${offenders.join(' and ')} must not be set: this app validates X-Forwarded-For against ` +
			`${TRUSTED_PROXIES_ENV} itself, and ${ADDRESS_HEADER_ENV} makes the framework trust the ` +
			`header blindly (see #219). Unset ${ADDRESS_HEADER_ENV}/${XFF_DEPTH_ENV} and set ` +
			`${TRUSTED_PROXIES_ENV} to your proxy's address or CIDR instead. See docs/reverse-proxy.md.`
	);
}
