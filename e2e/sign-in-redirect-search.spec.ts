import { request as apiRequest } from '@playwright/test';
import { expect, test } from './fixtures';
import { E2E_API_HEADERS, E2E_BASE_URL } from './config';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from './seed';
import * as m from '../src/lib/paraglide/messages';

/**
 * The sign-in redirect carries the page a signed-out visitor asked for, and never its search
 * string (#838). The search holds what the user typed to find their own transactions (`q`, a
 * category name, a date range, a tag), and the target travels in a `Location` header, an address
 * bar and any proxy access log that keeps query strings.
 *
 * Read on the build, because the redirect is thrown by `hooks.server.ts` on the server this suite
 * serves. Two tests, separating two states each:
 *
 * - the first is red while the search travels (the planted marker is counted in `Location`);
 * - the journey is red when the pathname is dropped too, since a bare `/login` lands on `/`, and
 *   red while the search travels, since the landing then carries it.
 */

const MARKER = 'SignInSearchMarker838';
const REQUESTED = `/transactions?q=${MARKER}&category=${MARKER}`;

test.use({ storageState: { cookies: [], origins: [] } });

test('a signed-out request is sent to /login with its pathname and without its search', async () => {
	const client = await apiRequest.newContext({
		baseURL: E2E_BASE_URL,
		extraHTTPHeaders: E2E_API_HEADERS,
		storageState: { cookies: [], origins: [] }
	});
	try {
		const response = await client.get(REQUESTED, { maxRedirects: 0 });
		const location = response.headers()['location'] ?? '';
		// One comparison, so that every figure is printed when any of them is wrong.
		expect({
			status: response.status(),
			markers: location.split(MARKER).length - 1,
			target: new URL(location, E2E_BASE_URL).searchParams.get('redirectTo')
		}).toEqual({ status: 303, markers: 0, target: '/transactions' });
	} finally {
		await client.dispose();
	}
});

test('signing in from a searched page lands on that page, without the search', async ({ page }) => {
	await page.goto(REQUESTED);
	// The pathname only: the target is the first test's figure, and asserting it here as well would
	// leave the landing below unevaluated whenever the target is wrong.
	await expect(page).toHaveURL((url) => url.pathname === '/login');

	await page.getByLabel(m.login_email_label()).fill(E2E_USER_EMAIL);
	await page
		.getByRole('textbox', { name: m.login_password_label(), exact: false })
		.fill(E2E_USER_PASSWORD);
	await page.getByRole('button', { name: m.login_submit() }).click();

	await expect(page).toHaveURL(`${E2E_BASE_URL}/transactions`);
});
