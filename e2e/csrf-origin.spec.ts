import { expect, test } from '@playwright/test';
import { E2E_BASE_URL, E2E_LOCALE } from './config';

/**
 * CSRF refusal, asserted rather than assumed.
 *
 * Before this file, nothing under `e2e/` or `src/` asserted that a cross-origin form POST is
 * refused. The control itself is SvelteKit's and has always been on (`csrf.checkOrigin` defaults
 * to true and `svelte.config.js` sets no `csrf` option) — what was missing is anything that would
 * notice if that stopped being true.
 *
 * It matters more now than it did. The origin diagnostic added alongside this deliberately does
 * NOT touch the check: SvelteKit refuses above every hook, and taking that over merely to improve
 * an error message was rejected. So the thing this wave leans on is the thing nothing was
 * watching.
 *
 * The check is compiled out under `vite dev` (`respond.js` guards it with `!__SVELTEKIT_DEV__`),
 * which is why this can only live in e2e: the suite serves a production build via
 * `npm run build && npm run preview`.
 */

const FORM = { 'content-type': 'application/x-www-form-urlencoded', 'Accept-Language': E2E_LOCALE };
const BODY = 'email=csrf-probe@example.test&password=irrelevant-not-a-real-credential';

test('a form POST carrying a foreign Origin is refused', async ({ request }) => {
	const response = await request.post(`${E2E_BASE_URL}/login`, {
		headers: { ...FORM, Origin: 'https://evil.example' },
		data: BODY,
		maxRedirects: 0
	});
	expect(response.status()).toBe(403);
});

test('a form POST carrying no Origin at all is refused', async ({ request }) => {
	const response = await request.post(`${E2E_BASE_URL}/login`, {
		headers: FORM,
		data: BODY,
		maxRedirects: 0
	});
	expect(response.status()).toBe(403);
});

/**
 * The calibration, and it is not optional: without it the two assertions above pass on a server
 * that returns 403 to everything, and "CSRF is enforced" would be a statement about a broken app.
 * The same request with the right Origin has to get PAST the check — it still fails to log in,
 * because the credentials are nonsense, and that is a different refusal with a different status.
 */
test('the same POST with the matching Origin reaches the app', async ({ request }) => {
	const response = await request.post(`${E2E_BASE_URL}/login`, {
		headers: { ...FORM, Origin: E2E_BASE_URL },
		data: BODY,
		maxRedirects: 0
	});
	expect(response.status()).not.toBe(403);
});
