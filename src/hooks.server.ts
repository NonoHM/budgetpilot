import { redirect, type Handle, type ServerInit } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { paraglideMiddleware } from '$lib/paraglide/server';
import {
	areSecureCookiesEnabled,
	clearSessionCookie,
	readSessionUser,
	SESSION_COOKIE
} from '$lib/server/auth';
import { resolveDatabaseProvider } from '$lib/server/database/provider';
import { warnIfDatabaseRoleIsOverprivileged } from '$lib/server/database/privileges';
import { assertEnvironmentConfigured } from '$lib/server/env/assertConfigured';
import { ensureNameKeysBackfilled } from '$lib/server/naming/boot';
import { ensureDedupeKeyHashesBackfilled } from '$lib/server/import/dedupeBoot';
import { parseTrustedProxies } from '$lib/server/net/clientAddress';

// One gate, one throw, every problem — see server/env/assertConfigured.ts for why this replaced
// nine fail-fast checks and two module-load throws. It has to live in `init` rather than at module
// level for two reasons: BOOTSTRAP_TOKEN's check needs the database, and module code also runs
// during SvelteKit's postbuild analysis where no database exists. `init` runs once per server
// start and adapter-node awaits it before listening, so throwing here is still a
// crash-at-startup rather than a failure on some later request.
export const init: ServerInit = async () => {
	await assertEnvironmentConfigured();
	// Reports, never gates: see the module for why an over-privileged role is a loud warning
	// rather than a refusal to start.
	await warnIfDatabaseRoleIsOverprivileged();
	await ensureNameKeysBackfilled();
	await ensureDedupeKeyHashesBackfilled();
};

const PUBLIC_ROUTES = new Set(['/login', '/register', '/login/verify-totp']);

// Defense in depth: the real mechanism is areSecureCookiesEnabled() (via
// PUBLIC_INSTANCE), but this log makes the security state visible on every
// startup instead of relying on an operator happening to re-read the logs.
const secureCookies = areSecureCookiesEnabled();
// The provider is safe to print and worth printing: it is the one thing that decides which
// generated client and migration history the app just used, and a mismatch between what an
// operator intended and what actually loaded is otherwise invisible. Never log DATABASE_URL
// alongside it — that carries the database password, which is why only the provider is here.
console.log(
	`[budgetpilot] startup: PUBLIC_INSTANCE=${process.env.PUBLIC_INSTANCE ?? 'unset (defaults to secure)'} cookies-secure=${secureCookies} database-provider=${resolveDatabaseProvider(process.env)}`
);
// The warning fires on the opt-OUT, since that is the only way to reach this state:
// secure cookies are the default whenever PUBLIC_INSTANCE is anything but "false".
// Rate limiting keys on the client IP, so whether X-Forwarded-For is trusted is a security state
// worth printing on every start, like cookies-secure above. The empty-default line is written to
// TEACH, not just report: it names the setting, says when it is needed, and states the consequence
// of leaving it unset (see #219), so an operator behind a proxy who never configured it can act.
const trustedProxyRanges = parseTrustedProxies(process.env.TRUSTED_PROXIES);
if (trustedProxyRanges.length > 0) {
	console.log(
		`[budgetpilot] startup: TRUSTED_PROXIES set (${trustedProxyRanges.length} range(s)). X-Forwarded-For is trusted only from these peers; rate limiting keys on the forwarded client IP.`
	);
} else {
	console.log(
		'[budgetpilot] startup: TRUSTED_PROXIES is unset, so X-Forwarded-For is NOT trusted and rate limiting keys on the socket peer. Correct when the app is reached directly. If it sits behind a reverse proxy, set TRUSTED_PROXIES to the proxy IP or CIDR (docker inspect its container, or your LAN/Docker-network range): otherwise every visitor shares the proxy address and one attacker can rate-limit them all. See docs/reverse-proxy.md.'
	);
}
// ORIGIN is the only variable printed here that the app itself never reads: adapter-node consumes
// it, and its parse_origin returns undefined for an absent value with no throw and no warning.
// That silence IS the defect. With ORIGIN unset, handler.js builds the request URL from the Host
// header and DEFAULTS THE PROTOCOL TO https, so on a plain-http deployment url.origin is
// https://host while the browser sends Origin: http://host, and SvelteKit's CSRF check refuses
// every form submission. Every GET still renders and the healthcheck still passes, so the failure
// waits for the first account creation — which is why it needs to be said at startup rather than
// discovered. Exported for its spec.
export function originStartupMessage(origin: string | undefined): string {
	const configured = origin?.trim();
	if (configured) {
		return `[budgetpilot] startup: ORIGIN=${configured}. Form submissions are accepted only from this exact origin — if that is not the URL you type in the browser, protocol and port included, every login and registration will be refused as cross-site.`;
	}
	return '[budgetpilot] startup: ORIGIN is unset, so the request URL is built from the Host header with the protocol defaulting to https. On a plain-http deployment that makes every form submission — login and account creation included — fail with "Cross-site POST form submissions are forbidden", while every page still loads and the healthcheck still passes. Set ORIGIN to the exact URL you type in the browser, protocol and port included and no trailing slash (e.g. http://localhost:3000). See docs/troubleshooting.md.';
}
console.log(originStartupMessage(process.env.ORIGIN));
if (!secureCookies) {
	console.warn(
		'[budgetpilot] ⚠️ SECURITY: PUBLIC_INSTANCE=false, LAN mode: session cookies are sent WITHOUT the Secure flag. This is correct for a private instance reached over plain http:// on a trusted network, and unsafe anywhere else. If this instance is reachable from the Internet, remove PUBLIC_INSTANCE=false and serve it over HTTPS.'
	);
}

// Per-request locale via AsyncLocalStorage: essential so that server-side
// getLocale() never leaks from one concurrent request to another.
const handleParaglide: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, async ({ request, locale }) => {
		event.request = request;
		const response = await resolve(event, {
			transformPageChunk: ({ html }) => html.replace('%paraglide.lang%', locale)
		});

		// The rendered body genuinely depends on Accept-Language: with no PARAGLIDE_LOCALE
		// cookie, Paraglide's 'preferredLanguage' strategy negotiates the locale from that
		// header, so the same URL returns French or English to two different visitors.
		// Nothing was telling caches so — Paraglide's own middleware only emits Vary on its
		// redirect branch, which requires the 'url' strategy this app does not use. Inert in
		// the documented Caddy deployment (it does not cache), but this is self-hosted
		// software: an operator putting a CDN or a shared proxy in front of it would otherwise
		// serve the first visitor's language to everyone behind that cache.
		//
		// Measured limit, so nobody reads the absence as a bug: the 303s handleAuth throws for
		// an unauthenticated request never reach here. SvelteKit converts a thrown redirect into
		// a Response above every `handle`, so no hook can decorate it. That is harmless — those
		// responses carry no body and their Location does not depend on the language — but it
		// does mean "every response has Vary" is false, and a check written on that premise
		// would fail for a reason that is not this one.
		appendVary(response.headers, 'Accept-Language');
		// Content-Language describes the language of a document, so it goes on documents only.
		// The negotiated locale is exactly what `<html lang>` was just set to above.
		if (response.headers.get('Content-Type')?.startsWith('text/html')) {
			response.headers.set('Content-Language', locale);
		}
		return response;
	});

// `set` would drop a Vary SvelteKit itself added; a duplicate entry is legal but noisy and
// invites a future reader to "fix" the wrong half. Case-insensitive because the field values
// are tokens, not text. `*` means "unpredictable, never reuse this response" and already
// subsumes any field, so adding to it would only weaken it into a list.
// Exported for hooks.server.spec.ts — the header it writes is verified against a running
// server, but the merge rules are logic and deserve their own cases.
export function appendVary(headers: Headers, field: string) {
	const existing = headers.get('Vary');
	if (!existing) {
		headers.set('Vary', field);
		return;
	}
	if (existing === '*') return;
	const already = existing.split(',').some((f) => f.trim().toLowerCase() === field.toLowerCase());
	if (!already) headers.set('Vary', `${existing}, ${field}`);
}

// Exported for tests (hooks.server.spec.ts): the auth logic is tested outside
// the sequence() pipeline, which requires SvelteKit's internal request store.
export const handleAuth: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE);
	const user = await readSessionUser(token);
	event.locals.user = user;

	if (token && !user) {
		clearSessionCookie(event.cookies);
	}

	const routeId = event.route.id;
	if (routeId && !PUBLIC_ROUTES.has(routeId) && !user) {
		throw redirect(
			303,
			`/login?redirectTo=${encodeURIComponent(event.url.pathname + event.url.search)}`
		);
	}

	// A user with forcePasswordChange active must always be able to log out
	// (never trap them with no way out): /logout stays always accessible.
	if (user?.forcePasswordChange && routeId !== '/force-password-change' && routeId !== '/logout') {
		throw redirect(303, '/force-password-change');
	}

	return resolve(event);
};

// Headers not covered by kit.csp (svelte.config.js): frame-ancestors there already blocks
// framing per CSP, X-Frame-Options is a defense-in-depth duplicate for older browsers.
// HSTS is conditioned on areSecureCookiesEnabled() (same fail-safe signal as the Secure
// cookie flag): sending it over a plain-HTTP local/LAN deployment would be actively harmful
// (browsers would refuse to connect over http:// afterwards).
export const handleSecurityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'same-origin');
	if (secureCookies) {
		response.headers.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
	}
	return response;
};

export const handle: Handle = sequence(handleParaglide, handleAuth, handleSecurityHeaders);
