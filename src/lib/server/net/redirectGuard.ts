/**
 * SSRF-safe redirect handling for server-side fetches to gated external services.
 *
 * The bug this closes (#215) is the guard-scope rule applied to SSRF: an allowlist that validates
 * the STARTING URL says nothing about where a redirect lands. `fetch` follows 3xx responses by
 * default, so an allowlisted base URL can bounce the server to an arbitrary internal host
 * (`http://127.0.0.2/latest/meta-data/`) with nothing re-checking the destination.
 *
 * The fix is to stop auto-following (`redirect: 'manual'`) and re-run the SAME host allowlist against
 * every redirect target before following it, refusing anything the allowlist would have refused as a
 * base URL. The allowlist now inspects the final destination, not only the first hop.
 *
 * Server-only: Node/undici returns the real 3xx response with a readable `Location` under
 * `redirect: 'manual'`, unlike a browser, which opaque-filters it. Verified against undici before
 * this was written.
 */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A redirect was refused because its target host is not allowlisted, or the chain was too long. */
export class SsrfRedirectError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SsrfRedirectError';
	}
}

export interface RedirectGuardOptions {
	/** Injectable for tests; defaults to the global fetch. */
	fetchImpl?: typeof fetch;
	/** Hard cap on how many allowlisted redirects to follow before giving up. */
	maxRedirects?: number;
	/**
	 * Returns true when a redirect target's host AND protocol are allowlisted. Pass the same
	 * validator the caller uses for its base URL, so the redirect is held to the identical rule
	 * (e.g. `(u) => getBankProviderBaseUrl(u.href, env) !== null`).
	 */
	isRedirectTargetAllowed: (target: URL) => boolean;
}

/**
 * Performs a fetch that never follows a redirect to a non-allowlisted host. On a 3xx it validates
 * the `Location` target through `isRedirectTargetAllowed`; if allowed it follows one hop (up to
 * `maxRedirects`), otherwise it throws `SsrfRedirectError`. Credential headers are dropped on a
 * cross-origin hop, matching what the browser's own auto-follow does, so a redirect cannot carry a
 * bearer token or cookie to a different host even when that host is allowlisted.
 */
export async function fetchWithRedirectGuard(
	url: string,
	init: RequestInit,
	options: RedirectGuardOptions
): Promise<Response> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const maxRedirects = options.maxRedirects ?? 5;

	let currentUrl = url;
	let currentInit: RequestInit = { ...init, redirect: 'manual' };

	for (let hop = 0; ; hop++) {
		const response = await fetchImpl(currentUrl, currentInit);

		const location = REDIRECT_STATUSES.has(response.status)
			? response.headers.get('location')
			: null;
		// Not a redirect (or a 3xx with no Location, which is not followable): this is the response.
		if (location === null) return response;

		if (hop >= maxRedirects) {
			throw new SsrfRedirectError(`refusing to follow more than ${maxRedirects} redirects`);
		}

		let target: URL;
		try {
			target = new URL(location, currentUrl);
		} catch {
			throw new SsrfRedirectError('redirect Location is not a resolvable URL');
		}

		// The whole point of #215: the allowlist inspects the DESTINATION, not only the first hop.
		if (!options.isRedirectTargetAllowed(target)) {
			throw new SsrfRedirectError('redirect target host is not allowlisted');
		}

		currentInit = nextHopInit(currentInit, currentUrl, target, response.status);
		currentUrl = target.toString();
	}
}

function nextHopInit(init: RequestInit, fromUrl: string, toUrl: URL, status: number): RequestInit {
	const next: RequestInit = { ...init, redirect: 'manual' };

	// Strip credential headers when the origin changes, so a redirect can never carry the
	// Authorization bearer (or a cookie) to a different host, even an allowlisted one. This
	// reproduces the browser's own cross-origin auto-follow behaviour that `redirect: 'manual'`
	// would otherwise take away from us.
	if (new URL(fromUrl).origin !== toUrl.origin && next.headers) {
		const headers = new Headers(next.headers as HeadersInit);
		headers.delete('authorization');
		headers.delete('cookie');
		next.headers = headers;
	}

	// WHATWG fetch redirect semantics: a 303, and a 301/302 on a non-GET/HEAD method, become a GET
	// with no body. 307/308 preserve method and body.
	const method = (next.method ?? 'GET').toUpperCase();
	if (
		status === 303 ||
		((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')
	) {
		next.method = 'GET';
		next.body = undefined;
	}

	return next;
}
