import { redirect, type Handle, type HandleServerError, type ServerInit } from '@sveltejs/kit';
import { building, dev } from '$app/environment';
import { sequence } from '@sveltejs/kit/hooks';
import { paraglideMiddleware } from '$lib/paraglide/server';
import {
	areSecureCookiesEnabled,
	readSessionUser,
	deadSessionReason,
	SESSION_COOKIE,
	signInUrl
} from '$lib/server/auth';
import { resolveDatabaseProvider } from '$lib/server/database/provider';
import { warnIfDatabaseRoleIsOverprivileged } from '$lib/server/database/privileges';
import { assertEnvironmentConfigured } from '$lib/server/env/assertConfigured';
import { exposedEnvFileMode, readEnvFileMode } from '$lib/server/env/envFileMode';
import { ensureNameKeysBackfilled } from '$lib/server/naming/boot';
import {
	ensureDedupeKeyHashesBackfilled,
	ensureDedupeKeysAtCurrentVersion
} from '$lib/server/import/dedupeBoot';
import { ensureStatementAccountsBackfilled } from '$lib/server/import/accountBoot';
import { ensureNoContestedNetWorthLinks } from '$lib/server/net-worth/contestedBoot';
import { reportDatesOutsideStorableRange } from '$lib/server/database/storableDatesBoot';
import { applySessionSettingsAtStart } from '$lib/server/auth/sessionBoot';
import { parseTrustedProxies } from '$lib/server/net/clientAddress';
import { installLastResortErrorHandlers } from '$lib/server/lastResortErrors';
import { APP_VERSION } from '$lib/server/appVersion';
import {
	errorFields,
	handleLogContext,
	installConsoleBridge,
	log,
	requestErrorId,
	type LogEvent
} from '$lib/server/logging';
import { logDeadSession } from '$lib/server/logging/authn';
import { ATTRIBUTE as A, EVENT as E } from '$lib/server/logging/names';
import { describeLogSettings } from '$lib/server/logging/settings';

// Before `init` can fail, which is the boot half of #816: Node's own printer would otherwise write a
// failing backfill's nested database message, which can quote a user's transaction. Not in dev, whose
// Vite process owns its handlers and its console, and not during the build's analysis pass, which is
// not a server. The console bridge turns what a dependency prints (adapter-node's « Listening on »)
// into a JSON line like every other, so stdout stays one object per line.
if (!dev && !building) {
	installConsoleBridge();
	installLastResortErrorHandlers();
}

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
	// After the hash backfill, never before: a row with no hash is invisible to every duplicate
	// check, and the recompute must not walk rows that one has not reached.
	await ensureDedupeKeysAtCurrentVersion();
	// After the recompute, and the reason is one-directional: the recompute READS `accountId` as a
	// key field, while this backfill writes account metadata and never touches one. Keys first so
	// the pass that can rewrite them finishes before the pass that must not.
	await ensureStatementAccountsBackfilled();
	// Last, and the order is not load bearing in either direction: this reads and writes only
	// `Account.netWorthAccountId`, which no backfill above reads or writes. Placed after them so a
	// pass that CAN move rows between buckets finishes before the pass that counts buckets per line.
	await ensureNoContestedNetWorthLinks();
	// Reports, never gates and never writes: counts rows dated before the storable range, written
	// before #758 made every writer refuse them. Last because it reads what the passes above settle.
	await reportDatesOutsideStorableRange();
	// Writes only `Session.expiresAt`, which no step above reads, so its place among them is not load
	// bearing. Before the server listens, so no request is served under a setting not yet applied.
	await applySessionSettingsAtStart();
};

// /setup/origin-mismatch is public because the operator it exists for has no account yet: an auth
// redirect would send them to /login, which is the screen the misconfiguration has them stuck on.
// It carries nothing but the origin of the page it is being served from and static instructions.
const PUBLIC_ROUTES = new Set([
	'/login',
	'/register',
	'/login/verify-totp',
	'/setup/origin-mismatch'
]);

// Defense in depth: the real mechanism is areSecureCookiesEnabled() (via PUBLIC_INSTANCE), but the
// startup line makes the security state visible on every start instead of relying on an operator
// happening to re-read the configuration.
const secureCookies = areSecureCookiesEnabled();
// Rate limiting keys on the client IP, so whether X-Forwarded-For is trusted is a security state
// worth reporting on every start (#219).
const trustedProxyRanges = parseTrustedProxies(process.env.TRUSTED_PROXIES);
// A .env other local accounts can read or write is a secret disclosed to them, or a configuration
// they can rewrite (#826). Read here, once per start; reported, never refused.
// Under Docker the file is on the host, read by Compose, so this check cannot see it: creation
// (scripts/env-file.mjs, the docs' .env block) and the upgrade step in docs/operations.md cover it.
const envFileExposure = exposedEnvFileMode(readEnvFileMode(process.cwd()), process.platform);

/**
 * What the server says about itself when it starts, as events: `sys_startup` with the
 * security-relevant configuration as closed values, then one line per state an operator should act
 * on. A pure function of the environment and three facts read above, for its spec.
 *
 * Never DATABASE_URL, which carries the database password: only the provider. Never the raw
 * PUBLIC_INSTANCE value: the mode it selects. The configured ORIGIN is printed because it is the
 * operator's own URL and the one variable whose wrong value fails silently: adapter-node consumes it
 * with no warning, and with it unset the request URL defaults to https, so on a plain-http
 * deployment SvelteKit's CSRF check refuses every form while every page and the healthcheck work.
 */
export function startupEvents(
	env: Record<string, string | undefined>,
	facts: { secureCookies: boolean; trustedProxyRanges: number; exposedEnvFileMode: string | null }
): LogEvent[] {
	const settings = describeLogSettings(env);
	const origin = env.ORIGIN?.trim();
	const events: LogEvent[] = [
		{
			event: E.sysStartup,
			attributes: {
				[A.serviceVersion]: APP_VERSION,
				[A.configPublicInstance]: facts.secureCookies ? 'secure' : 'lan',
				[A.configCookiesSecure]: facts.secureCookies,
				[A.configDatabaseProvider]: resolveDatabaseProvider(env),
				[A.configTrustedProxyRanges]: facts.trustedProxyRanges,
				[A.configOriginSet]: Boolean(origin),
				[A.configSecurityLog]: settings.securityLog,
				[A.configLogLevel]: settings.level
			}
		},
		origin
			? { event: E.configOriginSet, attributes: { [A.configOrigin]: origin } }
			: { event: E.configOriginUnset, attributes: {} }
	];
	if (facts.trustedProxyRanges === 0) {
		events.push({ event: E.configTrustedProxiesUnset, attributes: {} });
	}
	if (!facts.secureCookies) events.push({ event: E.configInsecureCookies, attributes: {} });
	if (facts.exposedEnvFileMode !== null) {
		events.push({
			event: E.configEnvFileExposed,
			attributes: { [A.configFileMode]: facts.exposedEnvFileMode }
		});
	}
	return events;
}

for (const event of startupEvents(process.env, {
	secureCookies,
	trustedProxyRanges: trustedProxyRanges.length,
	exposedEnvFileMode: envFileExposure
})) {
	log(event);
}

// The value this escapes is NOT trusted. With ORIGIN unset, adapter-node builds the request URL
// from the Host header, so `url.origin` carries a request header, and a request header is whatever
// the client sent. Interpolated raw into `content=""` a crafted Host would close the attribute and
// open a tag. `encodeURIComponent` is the wrong tool here — it leaves `&` alone in some positions
// and mangles the `//` and `:` that make the value readable — so the three characters that matter
// inside a double-quoted attribute are replaced explicitly, `&` first so it cannot double-encode
// the entities the later replacements introduce.
// Exported for hooks.server.spec.ts.
export function escapeHtmlAttribute(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

// Per-request locale via AsyncLocalStorage: essential so that server-side
// getLocale() never leaks from one concurrent request to another.
const handleParaglide: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, async ({ request, locale }) => {
		event.request = request;
		const response = await resolve(event, {
			transformPageChunk: ({ html }) =>
				html
					.replace('%paraglide.lang%', locale)
					// See app.html: the origin SvelteKit's CSRF check will compare the browser's Origin
					// header against, transported for the client probe.
					.replace('%budgetpilot.serverOrigin%', escapeHtmlAttribute(event.url.origin))
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
	// A cookie that no longer works is written with why (L3), by one more read on this path only.
	if (token && !user) {
		const dead = await deadSessionReason(token);
		if (dead) logDeadSession(dead.reason, dead.userId);
	}

	// A cookie that resolves to no session is LEFT in place, never deleted here. It grants nothing,
	// and the next sign-in overwrites it. Deleting it is what turned a harmless race into a sign-out:
	// a request another tab sent with the token a re-authenticated change had just replaced (#249)
	// would answer with a deletion, and the browser applying that after the change's own response
	// lost the new cookie. `/logout` and account deletion still clear the cookie they end.

	const routeId = event.route.id;
	if (routeId && !PUBLIC_ROUTES.has(routeId) && !user) {
		throw redirect(303, signInUrl(event.url));
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

/**
 * The request half of #816: SvelteKit's default printed `error.stack`, message first, and a database
 * message can quote the row it refused. The error is reduced to its class and code by the one rule
 * in server/errors.ts (`errorFields` calls `loggableError` and nothing else reads the error).
 *
 * The error id is the request's own id, generated by `handleLogContext`, so the reference a visitor
 * reports from the error page is the `budgetpilot.error.id` of the line, and the same request's
 * `trace_id` without its dashes. The method and the route template come from that context too; the
 * path is never written, because it is the one part of a request a visitor types freely. The message
 * returned is SvelteKit's own generic one, never the error's (`v5.0.0-16.5.1`).
 */
export const handleError: HandleServerError = ({ error, status, message }) => {
	const errorId = requestErrorId() ?? crypto.randomUUID();
	if (status === 404) {
		log({
			event: E.requestNotFound,
			attributes: { [A.httpStatus]: status, [A.errorId]: errorId }
		});
	} else {
		log({
			event: E.requestFailed,
			attributes: { ...errorFields(error), [A.httpStatus]: status, [A.errorId]: errorId }
		});
	}
	return { message, errorId };
};

// The log context first, before `handleAuth`, so every line a request writes carries its id
// (#250). Kit's own origin check answers before any of these runs.
export const handle: Handle = sequence(
	handleLogContext,
	handleParaglide,
	handleAuth,
	handleSecurityHeaders
);
