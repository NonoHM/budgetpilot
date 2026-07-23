import { redirect, type Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { paraglideMiddleware } from '$lib/paraglide/server';
import {
	areSecureCookiesEnabled,
	clearSessionCookie,
	readSessionUser,
	SESSION_COOKIE
} from '$lib/server/auth';

const PUBLIC_ROUTES = new Set(['/login', '/register', '/login/verify-totp']);

// Defense in depth: the real mechanism is areSecureCookiesEnabled() (via
// PUBLIC_INSTANCE), but this log makes the security state visible on every
// startup instead of relying on an operator happening to re-read the logs.
const secureCookies = areSecureCookiesEnabled();
console.log(
	`[budgetpilot] startup — NODE_ENV=${process.env.NODE_ENV ?? 'undefined'} PUBLIC_INSTANCE=${process.env.PUBLIC_INSTANCE ?? 'false'} cookies-secure=${secureCookies}`
);
if (!secureCookies) {
	console.warn(
		'[budgetpilot] ⚠️ SECURITY: session cookies without the Secure flag. If this instance is exposed on the Internet, set PUBLIC_INSTANCE=true (requires real HTTPS access).'
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
