import { request as apiRequest, type APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';
import { E2E_BASE_URL } from './config';

/**
 * ASVS 5.0 response-header contract, the BUILT-SERVER half. The other half is
 * src/hooks.server.spec.ts, which asserts the values handleSecurityHeaders writes by calling it
 * directly.
 *
 * Three questions can only be asked here, and each is why this file exists rather than being
 * folded into the unit spec:
 *
 *  1. v5.0.0-4.1.1, the missing charset. It is produced by SvelteKit's renderer
 *     (`@sveltejs/kit/src/runtime/server/page/render.js` sets `content-type: text/html` with no
 *     charset parameter), so no call to our own hook can observe it.
 *  2. Whether handleSecurityHeaders is still WIRED IN. It is registered in `sequence(...)` at the
 *     bottom of hooks.server.ts, and deleting it from that list leaves every unit assertion in
 *     hooks.server.spec.ts green while the application ships with no security headers at all.
 *     Only a real response can tell those two states apart.
 *  3. Whether the CSP declared in svelte.config.js is actually EMITTED. The unit spec pins the
 *     directives; a changed `mode`, a framework upgrade or a route overwriting the header would
 *     leave that green and this red.
 *
 * WHAT THIS HARNESS IS NOT FAITHFUL ABOUT, measured rather than assumed, because a harness that
 * alters what it measures is the failure this file is most exposed to:
 *
 *  - **`Access-Control-Allow-Origin` is NOT assertable here.** The suite serves the app with
 *    `npm run preview`, and vite's preview server adds `Access-Control-Allow-Origin: *` to every
 *    response on its own. Measured 2026-08-13 on this build: `vite preview` sends it, the shipped
 *    artifact (`node build/index.js`, adapter-node) does not. So an absence assertion here would
 *    fail against code that is correct, and a presence assertion would pin vite's behaviour as if
 *    it were ours. v5.0.0-3.4.2 is therefore asserted at the hook and in a source scan, both in
 *    hooks.server.spec.ts, and deliberately not here. Do not "fix" this file by adding it.
 *  - **HSTS cannot be observed in this suite**, because `.env.test` sets `PUBLIC_INSTANCE=false`
 *    (LAN mode), which is exactly the branch that must NOT send it. Its presence branch is a unit
 *    assertion; its absence branch is asserted below, on the wire, where it is real.
 */

// Unauthenticated and rendered: /login is a 200 through the full renderer. The status assertion
// in each test is load-bearing rather than decorative. An unauthenticated request to any
// protected route is a 303 thrown by handleAuth, and SvelteKit builds those with its own helper,
// which DOES emit `text/html; charset=utf-8`. A charset test that silently landed on a redirect
// would read the framework's correct header and report the gap as closed.
const RENDERED_PAGE = '/login';

test.describe('ASVS response headers on a built server', () => {
	// An explicitly UNAUTHENTICATED context, and the EMPTY storageState is the whole reason this
	// is three lines instead of one.
	//
	// Measured 2026-08-13, after this file first reported a product defect that did not exist.
	// Playwright's `request` fixture inherits `storageState` from playwright.config.ts, which is
	// documented. What is not obvious is that a context built by hand with
	// `apiRequest.newContext({ baseURL })` inherits it TOO: `anon.storageState()` came back
	// holding the suite's `budgetpilot_session` cookie, so `anon.get('/')` returned 200 and the
	// 303 assertion below failed against an application that was behaving correctly. An
	// "unauthenticated" request that silently carries the shared session reads exactly like an
	// anonymous one at the call site, and every anonymous assertion in this file would have been
	// describing an authenticated request.
	//
	// Passing an explicit empty state is what makes anonymity a declared fact rather than an
	// inherited default. Note for anyone reusing the pattern: `e2e/transactions-filter-persistence.spec.ts`
	// builds a context the same way and then calls `loginE2eUser` on it, which is harmless there
	// (it wants a session) and is not evidence that the context starts clean.
	let anon: APIRequestContext;

	test.beforeAll(async () => {
		anon = await apiRequest.newContext({
			baseURL: E2E_BASE_URL,
			storageState: { cookies: [], origins: [] }
		});
	});

	test.afterAll(async () => {
		await anon.dispose();
	});

	// EXCEPTION, pinned at its current wrong value (v5.0.0-4.1.1). Every rendered page is served
	// as `text/html` with no charset parameter. Mitigated by nosniff and `<meta charset="utf-8">`
	// in app.html, and modern browsers default HTML to UTF-8, which is why it is an accepted
	// exception rather than an issue. Pinned so that the day it is fixed, this test goes red and
	// the published assessment row has to move with it.
	test('EXCEPTION (v5.0.0-4.1.1): a rendered page sends text/html with no charset', async () => {
		const response = await anon.get(RENDERED_PAGE);

		expect(response.status()).toBe(200);
		expect(response.headers()['content-type']).toBe('text/html');
	});

	// The control for the assertion above, and it is not optional. "No charset parameter" and "this
	// harness cannot read a charset parameter" produce the identical reading, and the second is a
	// broken test reporting the answer it was hoping for. A response that DOES carry one proves the
	// channel works before an absence is allowed to mean anything.
	//
	// The control is a real application response rather than a fixture, so it pins two rows at
	// once: our own CSV export sets `text/csv; charset=utf-8` (v5.0.0-4.1.1 is met wherever we set
	// the header ourselves; the gap is the framework's) and `Content-Disposition: attachment`,
	// which is v5.0.0-3.2.1 on the wire rather than in a unit test.
	test('control (v5.0.0-4.1.1, v5.0.0-3.2.1): our own CSV export sends a charset, and attachment', async ({
		page
	}) => {
		const response = await page.request.get('/transactions/export');

		expect(response.status()).toBe(200);
		expect(response.headers()['content-type']).toBe('text/csv; charset=utf-8');
		expect(response.headers()['content-disposition']).toContain('attachment');
	});

	// This is the test that would go red if handleSecurityHeaders were dropped from sequence().
	test('v5.0.0-3.4.4/3.4.5/3.4.6: the hook headers reach a real response', async () => {
		const response = await anon.get(RENDERED_PAGE);
		const headers = response.headers();

		expect(response.status()).toBe(200);
		expect(headers['x-content-type-options']).toBe('nosniff');
		expect(headers['referrer-policy']).toBe('same-origin');
		expect(headers['x-frame-options']).toBe('DENY');
	});

	test('v5.0.0-3.4.3/3.4.6: the CSP declared in svelte.config.js is emitted, nonce and all', async () => {
		const response = await anon.get(RENDERED_PAGE);
		const csp = response.headers()['content-security-policy'];

		expect(response.status()).toBe(200);
		expect(csp).toBeTruthy();

		// The minimum the requirement names, plus the framing directive of v5.0.0-3.4.6.
		expect(csp).toContain("object-src 'none'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("default-src 'self'");

		// `mode: 'auto'` in svelte.config.js is what makes this nonce-based, which is the
		// alternative to an allowlist that the requirement accepts. Asserting the directives
		// without the nonce would stay green if the mechanism were switched off.
		expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);

		// The deliberate exception, asserted positively for the same reason as in the unit spec:
		// unasserted, it reads to the next sweep as the regression the next line forbids.
		expect(csp).toContain("style-src-attr 'unsafe-inline'");
		expect(csp).toContain("style-src 'self';");
		expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
	});

	// The absence branch of HSTS, on the wire. `.env.test` runs this suite with
	// PUBLIC_INSTANCE=false, and sending HSTS over a plain-HTTP LAN deployment would teach the
	// browser to refuse http:// afterwards, which is the harm the branch exists to avoid. So this
	// asserts the fail-safe actually reaches the response, not merely the hook.
	test('v5.0.0-3.4.1: no HSTS in LAN mode (PUBLIC_INSTANCE=false), on the wire', async () => {
		const response = await anon.get(RENDERED_PAGE);

		expect(response.status()).toBe(200);
		expect(response.headers()['strict-transport-security']).toBeUndefined();
	});

	/**
	 * A MEASURED GAP IN v5.0.0-3.4.4, pinned at its current wrong value.
	 *
	 * The published assessment says nosniff is set "unconditionally on every response ... with no
	 * branch". That is true of the hook and false of the server: the hook only decorates responses
	 * that pass through SvelteKit's handler, and TWO classes of response do not. Static immutable
	 * assets are one, and are asserted below. Thrown 303 redirects are the other, and are NOT
	 * asserted, for a reason worth recording rather than leaving as an apparent omission.
	 *
	 * WHY THE REDIRECT HALF IS PROSE AND NOT A TEST. It was written as a test first, and the
	 * break-check could not make it fail. Two breaks were tried: handleAuth RETURNING the 303
	 * instead of throwing it, and handleSecurityHeaders moved to the OUTERMOST position in
	 * `sequence(...)`. Both left all seven tests green. SvelteKit converts a thrown redirect into a
	 * Response above every handle hook, so no ordering of ours can decorate it, and
	 * handleSecurityHeaders is innermost anyway, so any early return upstream bypasses it too. An
	 * assertion nothing under our control can turn red is not a guard: it is a line that would
	 * count toward a green suite forever while proving nothing, and the only break that COULD move
	 * it (making `/` a public route) would fail on the status assertion, for a reason that is not
	 * this one.
	 *
	 * Measured 2026-08-13 against the shipped artifact (`node build/index.js`) as well as this
	 * harness, so neither reading is a preview-server artifact.
	 *
	 * Consequence is low in both cases, which is why the asset gap is pinned rather than fixed
	 * here: immutable assets are content-hashed CSS and JS with a correct Content-Type and no
	 * user-controlled bytes (uploads are never stored and never served back), and a 303 carries no
	 * body to sniff or frame. But the assessment's wording is wider than the code.
	 */
	test('MEASURED GAP (v5.0.0-3.4.4): a static immutable asset carries no security headers', async () => {
		const page = await anon.get(RENDERED_PAGE);
		const asset = /\/_app\/immutable\/assets\/[^"]+\.css/.exec(await page.text())?.[0];

		// Calibration: if the page stopped linking a hashed stylesheet, the assertions below would
		// be about a 404 and would pass for the wrong reason.
		expect(asset).toBeTruthy();

		const response = await anon.get(asset as string);
		expect(response.status()).toBe(200);
		expect(response.headers()['content-type']).toContain('text/css');
		// Served by adapter-node's static middleware, ahead of the SvelteKit handler, so no hook
		// ever sees it.
		expect(response.headers()['x-content-type-options']).toBeUndefined();
	});
});
