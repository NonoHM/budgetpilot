import { expect, test, type Page } from '@playwright/test';
import { E2E_BASE_URL } from './config';
import { BYPASS_HOST, REDIRECT_BYPASSES } from '../src/lib/server/auth/redirectBypasses';

/**
 * Where a real browser lands after the sign-in redirect, for every bypass in the shared corpus.
 *
 * The unit spec asks the function what it returns; this asks the question the advisory left
 * unmeasured: what Chromium does with the `Location` header the built application sends. The path
 * is `/login`'s `load` for a visitor who is already signed in (every spec here inherits a session
 * from `storageState`), which redirects on a plain GET with no form to fill.
 *
 * Every request the page issues is recorded from the `request` event, which fires once per redirect
 * hop. `page.route` does NOT see a request reached by following a redirect: the first version of
 * this file intercepted with it, counted zero on both bypasses that really left the origin, and was
 * red only because of the landing assertion. The calibration at the bottom goes through a redirect
 * hop for that reason.
 *
 * The bypass host is mapped to a closed local port, so a working bypass is a refused connection in
 * milliseconds rather than a DNS timeout, and nothing leaves the machine.
 */

const APP_ORIGIN = new URL(E2E_BASE_URL).origin;

test.use({ launchOptions: { args: [`--host-resolver-rules=MAP ${BYPASS_HOST} 127.0.0.1:9`] } });

async function navigate(page: Page, path: string) {
	const leftOrigin: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.origin !== APP_ORIGIN) leftOrigin.push(url.host);
	});
	// A bypass that works ends in a refused connection, which rejects the navigation. The two
	// assertions below say what happened; the rejection itself carries nothing more.
	await page.goto(path).catch(() => undefined);
	return { leftOrigin, landed: new URL(page.url()) };
}

function followSignInRedirect(page: Page, redirectTo: string) {
	return navigate(page, `/login?redirectTo=${encodeURIComponent(redirectTo)}`);
}

for (const bypass of REDIRECT_BYPASSES) {
	test(`a signed-in visitor sent to /login with ${bypass.name} lands on the dashboard`, async ({
		page
	}) => {
		const { leftOrigin, landed } = await followSignInRedirect(page, bypass.value);
		expect(leftOrigin).toEqual([]);
		expect(`${landed.origin}${landed.pathname}${landed.search}`).toBe(`${APP_ORIGIN}/`);
	});
}

// The positive control: without it, a function returning '/' for everything passes every test
// above, and so does a harness whose interception never fires.
test('a signed-in visitor sent to /login with an internal path lands on that path', async ({
	page
}) => {
	const { leftOrigin, landed } = await followSignInRedirect(page, '/settings');
	expect(leftOrigin).toEqual([]);
	expect(`${landed.origin}${landed.pathname}`).toBe(`${APP_ORIGIN}/settings`);
});

test('the detector records a foreign host reached through a redirect hop', async ({ page }) => {
	// Calibrates the detector on the path it is used for: a 303 from the application's origin whose
	// Location is foreign. The response is fulfilled locally, so this needs no route that redirects.
	const probe = `${APP_ORIGIN}/__redirect-probe`;
	await page.route(
		(url) => url.href === probe,
		(route) => route.fulfill({ status: 303, headers: { location: `https://${BYPASS_HOST}/` } })
	);
	const { leftOrigin } = await navigate(page, probe);
	expect(leftOrigin).toEqual([BYPASS_HOST]);
});
