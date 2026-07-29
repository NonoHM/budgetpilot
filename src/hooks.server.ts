import { redirect, type Handle, type ServerInit } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { paraglideMiddleware } from '$lib/paraglide/server';
import {
	areSecureCookiesEnabled,
	clearSessionCookie,
	readSessionUser,
	SESSION_COOKIE
} from '$lib/server/auth';
import { assertBootstrapTokenConfigured } from '$lib/server/auth/bootstrapToken';
import { ensureNameKeysBackfilled } from '$lib/server/naming/boot';
// Side-effect imports only: each module throws at load time if its required secret
// (RATE_LIMIT_HASH_SECRET, TOTP_ENCRYPTION_KEY) is missing/malformed. hooks.server.ts is
// the one module SvelteKit always loads at boot, so importing them here turns a missing
// secret into a loud crash-on-startup instead of a generic 500 on the first /login or
// /register request that happens to touch these route-specific server chunks.
import '$lib/server/auth/rateLimit';
import '$lib/server/crypto';

// Boot checks that need the database, and therefore can't be module-level: module code
// also runs during SvelteKit's postbuild analysis, where no database exists. `init` runs
// once per server start and adapter-node awaits it before listening, so throwing here is
// still a crash-at-startup rather than a failure on some later request.
export const init: ServerInit = async () => {
	await assertBootstrapTokenConfigured();
	await ensureNameKeysBackfilled();
};

const PUBLIC_ROUTES = new Set(['/login', '/register', '/login/verify-totp']);

// Defense in depth: the real mechanism is areSecureCookiesEnabled() (via
// PUBLIC_INSTANCE), but this log makes the security state visible on every
// startup instead of relying on an operator happening to re-read the logs.
const secureCookies = areSecureCookiesEnabled();
console.log(
	`[budgetpilot] startup: PUBLIC_INSTANCE=${process.env.PUBLIC_INSTANCE ?? 'unset (defaults to secure)'} cookies-secure=${secureCookies}`
);
// The warning fires on the opt-OUT, since that is the only way to reach this state:
// secure cookies are the default whenever PUBLIC_INSTANCE is anything but "false".
if (!secureCookies) {
	console.warn(
		'[budgetpilot] ⚠️ SECURITY: PUBLIC_INSTANCE=false, LAN mode: session cookies are sent WITHOUT the Secure flag. This is correct for a private instance reached over plain http:// on a trusted network, and unsafe anywhere else. If this instance is reachable from the Internet, remove PUBLIC_INSTANCE=false and serve it over HTTPS.'
	);
}

// Per-request locale via AsyncLocalStorage: essential so that server-side
// getLocale() never leaks from one concurrent request to another.
const handleParaglide: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request, locale }) => {
		event.request = request;
		return resolve(event, {
			transformPageChunk: ({ html }) => html.replace('%paraglide.lang%', locale)
		});
	});

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
