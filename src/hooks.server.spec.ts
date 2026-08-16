import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const auth = vi.hoisted(() => ({
	readSessionUser: vi.fn(),
	clearSessionCookie: vi.fn(),
	areSecureCookiesEnabled: vi.fn(() => false),
	SESSION_COOKIE: 'budgetpilot_session'
}));

vi.mock('$lib/server/auth', () => auth);

// handleAuth directement : le pipeline sequence() exige le request store interne de SvelteKit.
const { handleAuth: handle } = await import('./hooks.server');

describe('hooks auth', () => {
	it('redirige une page protégée vers /login si non authentifié', async () => {
		expect.assertions(1);

		auth.readSessionUser.mockResolvedValue(null);

		await expect(
			handle({
				event: buildEvent('/', undefined) as never,
				resolve: vi.fn()
			})
		).rejects.toMatchObject({ status: 303, location: '/login?redirectTo=%2F' });
	});

	it('laisse passer /login sans session', async () => {
		expect.assertions(2);

		auth.readSessionUser.mockResolvedValue(null);
		const resolve = vi.fn(async () => new Response('ok'));

		const response = await handle({
			event: buildEvent('/login', undefined) as never,
			resolve
		});

		expect(resolve).toHaveBeenCalled();
		expect(await response.text()).toBe('ok');
	});

	it("laisse passer /login/verify-totp sans session (l'utilisateur n'est pas encore pleinement authentifié à ce stade)", async () => {
		expect.assertions(2);

		auth.readSessionUser.mockResolvedValue(null);
		const resolve = vi.fn(async () => new Response('ok'));

		const response = await handle({
			event: buildEvent('/login/verify-totp', undefined) as never,
			resolve
		});

		expect(resolve).toHaveBeenCalled();
		expect(await response.text()).toBe('ok');
	});

	it('supprime le cookie si un jeton est présent mais ne correspond plus à une session valide', async () => {
		expect.assertions(2);

		auth.readSessionUser.mockResolvedValue(null);
		const event = buildEvent('/login', 'token-perime');
		const resolve = vi.fn(async () => new Response('ok'));

		await handle({
			event: event as never,
			resolve
		});

		expect(auth.clearSessionCookie).toHaveBeenCalledWith(event.cookies);
		expect(resolve).toHaveBeenCalled();
	});

	it('redirige un utilisateur forcePasswordChange vers /force-password-change depuis une route protégée arbitraire', async () => {
		expect.assertions(1);

		auth.readSessionUser.mockResolvedValue({
			id: 'user-a',
			email: 'user-a@example.test',
			role: 'USER',
			forcePasswordChange: true
		});

		await expect(
			handle({
				event: buildEvent('/transactions', 'token-valide') as never,
				resolve: vi.fn()
			})
		).rejects.toMatchObject({ status: 303, location: '/force-password-change' });
	});

	it('laisse passer /force-password-change malgré le flag forcePasswordChange (évite une boucle de redirection)', async () => {
		expect.assertions(2);

		auth.readSessionUser.mockResolvedValue({
			id: 'user-a',
			email: 'user-a@example.test',
			role: 'USER',
			forcePasswordChange: true
		});
		const resolve = vi.fn(async () => new Response('ok'));

		const response = await handle({
			event: buildEvent('/force-password-change', 'token-valide') as never,
			resolve
		});

		expect(resolve).toHaveBeenCalled();
		expect(await response.text()).toBe('ok');
	});

	it('laisse toujours passer /logout malgré le flag forcePasswordChange (échappatoire garantie)', async () => {
		expect.assertions(2);

		auth.readSessionUser.mockResolvedValue({
			id: 'user-a',
			email: 'user-a@example.test',
			role: 'USER',
			forcePasswordChange: true
		});
		const resolve = vi.fn(async () => new Response('ok'));

		const response = await handle({
			event: buildEvent('/logout', 'token-valide') as never,
			resolve
		});

		expect(resolve).toHaveBeenCalled();
		expect(await response.text()).toBe('ok');
	});

	it('ne redirige pas un utilisateur sans forcePasswordChange (flag false)', async () => {
		expect.assertions(1);

		auth.readSessionUser.mockResolvedValue({
			id: 'user-a',
			email: 'user-a@example.test',
			role: 'USER',
			forcePasswordChange: false
		});
		const resolve = vi.fn(async () => new Response('ok'));

		await handle({
			event: buildEvent('/transactions', 'token-valide') as never,
			resolve
		});

		expect(resolve).toHaveBeenCalled();
	});
});

// ASVS 5.0 response-header contract, part one of two: the VALUES this hook writes.
//
// The published self-assessment states twelve requirement rows whose entire content is one
// header value that a refactor can drop in silence, and a point-in-time document cannot
// notice when one of them stops being true. Each test below names its requirement id so a
// failure says which published row just became false, rather than only which string moved.
//
// WHAT THIS BLOCK STRUCTURALLY CANNOT SEE, recorded so its green is never read as wider than
// it is. It calls handleSecurityHeaders directly, so it observes the headers THIS HOOK
// writes and nothing else:
//
//   - v5.0.0-4.1.1, the missing charset on rendered pages, lives in SvelteKit's renderer
//     (@sveltejs/kit/src/runtime/server/page/render.js sets `content-type: text/html` with no
//     charset parameter). No direct call to this hook can observe it, which is why that row
//     is asserted against a built server in e2e/security-headers.spec.ts instead.
//   - The CSP header is produced by SvelteKit from svelte.config.js, not here. Its directives
//     are pinned in the 'CSP directives' block below and its EMISSION in the same e2e spec.
//   - Cookie attributes (v5.0.0-3.3.1 through 3.3.4) are set by the functions that create the
//     cookies, and are pinned beside them: src/lib/server/auth.spec.ts for the session cookie,
//     src/lib/server/auth/mfaChallenge.spec.ts for the MFA challenge cookie.
//   - `Content-Disposition: attachment` (v5.0.0-3.2.1) is pinned in each export endpoint's own
//     spec: routes/transactions/export/server.spec.ts, routes/settings/export/server.spec.ts.
//
// handleSecurityHeaders captures `secureCookies` in a module-level const, evaluated once
// at import time from areSecureCookiesEnabled() — so each case needs a fresh module
// instance (vi.resetModules) with the mock's return value set beforehand, same pattern as
// bootstrapToken.spec.ts's boot guard. The pre-imported `handle`/`handleAuth` above stay
// bound to the module instance captured before any of these resets, so they're unaffected.
describe('hooks handleSecurityHeaders', () => {
	afterEach(() => {
		auth.areSecureCookiesEnabled.mockReturnValue(false);
	});

	/** Imports a fresh module instance bound to the current areSecureCookiesEnabled() value. */
	async function runHook(resolve = vi.fn(async () => new Response('ok'))) {
		vi.resetModules();
		const { handleSecurityHeaders } = await import('./hooks.server');
		return handleSecurityHeaders({ event: {} as never, resolve } as never);
	}

	it('sets X-Frame-Options, X-Content-Type-Options and Referrer-Policy regardless of secure-cookie state', async () => {
		expect.assertions(3);

		auth.areSecureCookiesEnabled.mockReturnValue(false);
		const response = await runHook();

		// v5.0.0-3.4.6 (framing denied; the CSP frame-ancestors half is in the block below)
		expect(response.headers.get('X-Frame-Options')).toBe('DENY');
		// v5.0.0-3.4.4 (nosniff on every response) and part of v5.0.0-3.2.1
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		// v5.0.0-3.4.5 (referrer policy)
		expect(response.headers.get('Referrer-Policy')).toBe('same-origin');
	});

	it('adds Strict-Transport-Security when secure cookies are enabled at boot (PUBLIC_INSTANCE fail-secure default)', async () => {
		expect.assertions(1);

		auth.areSecureCookiesEnabled.mockReturnValue(true);
		const response = await runHook();

		expect(response.headers.get('Strict-Transport-Security')).toBe(
			'max-age=15552000; includeSubDomains'
		);
	});

	it('omits Strict-Transport-Security when secure cookies are disabled (PUBLIC_INSTANCE=false, plain-HTTP LAN)', async () => {
		expect.assertions(1);

		auth.areSecureCookiesEnabled.mockReturnValue(false);
		const response = await runHook();

		expect(response.headers.get('Strict-Transport-Security')).toBeNull();
	});

	// EXCEPTION, pinned at its current wrong value on purpose (#247, v5.0.0-3.4.1). The
	// requirement asks for a max-age of at least one year; this application sends 180 days.
	// Asserting the string alone would let the fix land with the published assessment still
	// saying the row is an exception, so the deviation itself is what is asserted: this test
	// goes RED the day #247 is fixed, and the fix's own diff is then forced to update it and
	// the row it cites. That is the intent, not an obstacle.
	it('EXCEPTION #247 (v5.0.0-3.4.1): HSTS max-age is 180 days, still short of the required year', async () => {
		expect.assertions(3);

		const ONE_YEAR_SECONDS = 31_536_000;
		auth.areSecureCookiesEnabled.mockReturnValue(true);
		const response = await runHook();

		const header = response.headers.get('Strict-Transport-Security') ?? '';
		const maxAge = Number(/max-age=(\d+)/.exec(header)?.[1]);

		expect(maxAge).toBe(15_552_000);
		expect(maxAge).toBeLessThan(ONE_YEAR_SECONDS);
		// The subdomain half of the requirement IS met, and stays asserted so that fixing the
		// number cannot quietly cost the directive.
		expect(header).toContain('includeSubDomains');
	});

	// v5.0.0-3.4.2. An absence assertion, so it gets the appear-then-disappear treatment: a
	// test that only asserts "no CORS header" passes identically in a world where the hook
	// never ran, where resolve() returned nothing, and where the assertion cannot read headers
	// at all. The first half proves this observation channel can SEE such a header before the
	// second half concludes anything from not seeing one.
	it('v5.0.0-3.4.2: adds no Access-Control-Allow-Origin, and would show one if it were there', async () => {
		expect.assertions(2);

		auth.areSecureCookiesEnabled.mockReturnValue(false);

		const withHeader = await runHook(
			vi.fn(async () => new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } }))
		);
		expect(withHeader.headers.get('Access-Control-Allow-Origin')).toBe('*');

		const plain = await runHook();
		expect(plain.headers.get('Access-Control-Allow-Origin')).toBeNull();
	});

	// EXCEPTION, pinned at its current wrong value on purpose (v5.0.0-14.3.2). No
	// `Cache-Control: no-store` is sent on any response, so every page showing balances and
	// transactions is left to browser heuristics and bfcache. Unlike v5.0.0-3.4.1 this one has
	// no issue of its own: it is published as an exception in the assessment's
	// "Transport, configuration and cookies" grouping and nowhere else. Same reasoning as
	// #247 above for asserting it: the day anti-caching headers are added, this goes red and
	// the published row must move with it.
	//
	// Scope, stated because the requirement is about every response and this test is about one
	// hook: it pins that the hook adds nothing. The application-wide claim ("no Cache-Control
	// is set anywhere") is a source-level property, asserted in the scan block below.
	it('EXCEPTION (v5.0.0-14.3.2): no anti-caching header is sent, and one would show if it were', async () => {
		expect.assertions(2);

		auth.areSecureCookiesEnabled.mockReturnValue(false);

		const withHeader = await runHook(
			vi.fn(async () => new Response('ok', { headers: { 'Cache-Control': 'no-store' } }))
		);
		expect(withHeader.headers.get('Cache-Control')).toBe('no-store');

		const plain = await runHook();
		expect(plain.headers.get('Cache-Control')).toBeNull();
	});
});

// ASVS 5.0 response-header contract, part two: the CSP DIRECTIVES.
//
// The policy is declared in svelte.config.js and emitted by SvelteKit's renderer, so it is
// reachable from neither handleSecurityHeaders nor any route. This block asserts the declared
// directives; e2e/security-headers.spec.ts asserts that a real response carries them.
//
// BOTH HALVES ARE NEEDED AND NEITHER SUBSTITUTES FOR THE OTHER, which is the whole reason this
// is not one test. A config assertion cannot see a policy that stops being emitted (a changed
// `mode`, a framework upgrade, a route that overwrites the header); a response assertion can
// only see the deployment mode the harness happens to run in. So: this block is the value, the
// e2e spec is the emission, and a failure names which of the two moved.
describe('CSP directives (svelte.config.js)', () => {
	it('v5.0.0-3.4.3: is nonce-based, with object-src none and no unsafe-inline in script-src or style-src', async () => {
		expect.assertions(6);

		const { default: config } = await import('../svelte.config.js');
		const csp = config.kit?.csp;

		// 'auto' is what makes it nonce-based on every dynamically rendered page, which is the
		// alternative the requirement offers to an allowlist. Losing it would leave the
		// directives below intact and the mechanism gone.
		expect(csp?.mode).toBe('auto');
		expect(csp?.directives?.['object-src']).toEqual(['none']);
		expect(csp?.directives?.['script-src']).toEqual(['self']);
		expect(csp?.directives?.['style-src']).toEqual(['self']);
		expect(csp?.directives?.['script-src']).not.toContain('unsafe-inline');
		expect(csp?.directives?.['style-src']).not.toContain('unsafe-inline');
	});

	// Asserted POSITIVELY, on purpose. `style-src-attr: 'unsafe-inline'` is a deliberate,
	// documented exception (SvelteKit's own announcer element and bits-ui's visually-hidden
	// helpers carry inline style attributes), and the reasoning sits next to it in
	// svelte.config.js. Left unasserted, a future reader sweeping for `unsafe-inline` reads it
	// as the regression the test above forbids and removes it. Pinning it states that its
	// presence is a decision, and pins its SCOPE: an inline style attribute is permitted, a
	// <style> block and an inline <script> are not.
	it('v5.0.0-3.4.3: permits inline style ATTRIBUTES only, through style-src-attr, deliberately', async () => {
		expect.assertions(2);

		const { default: config } = await import('../svelte.config.js');
		const directives = config.kit?.csp?.directives;

		expect(directives?.['style-src-attr']).toEqual(['unsafe-inline']);
		// The scope claim: nothing else in the policy carries the same escape hatch.
		const elsewhere = Object.entries(directives ?? {})
			.filter(([name]) => name !== 'style-src-attr')
			.filter(([, values]) => (values as string[]).includes('unsafe-inline'))
			.map(([name]) => name);
		expect(elsewhere).toEqual([]);
	});

	it('v5.0.0-3.4.6: denies framing by default through frame-ancestors none', async () => {
		expect.assertions(1);

		const { default: config } = await import('../svelte.config.js');

		expect(config.kit?.csp?.directives?.['frame-ancestors']).toEqual(['none']);
	});

	// DEVIATION FROM THE REQUIREMENT TEXT, pinned rather than corrected here, because correcting
	// it is a change to the application and this is the phase that makes claims checkable.
	// v5.0.0-3.4.3 names `base-uri 'none'` in its minimum policy; this application sends
	// `base-uri 'self'`. Reported to the owner 2026-08-13 as a finding against the published
	// assessment, which marks the row met. `'self'` still blocks an injected <base> pointing at
	// another origin, which is the attack the directive exists for; the gap is that a <base>
	// pointing at a same-origin path is permitted. Asserted at its current value so the row and
	// the code cannot drift further apart while the decision is open.
	it('v5.0.0-3.4.3: sends base-uri self, which is NOT the none the requirement names', async () => {
		expect.assertions(1);

		const { default: config } = await import('../svelte.config.js');

		expect(config.kit?.csp?.directives?.['base-uri']).toEqual(['self']);
	});
});

// EXCEPTION (v5.0.0-14.3.2), the application-wide half of the hook-level assertion above.
//
// The assessment's evidence for this row is a source-level claim: no Cache-Control header is
// set ANYWHERE, so no authenticated response carries `no-store`. A hook test cannot say that;
// only a scan can. Pinned at the current wrong value for the same reason as #247: the day
// anti-caching headers are added, this goes red and the published row has to move with it.
describe('anti-caching headers (v5.0.0-14.3.2)', () => {
	// Same `withFileTypes` reasoning as
	// src/lib/server/transactions/effective-category-single-source.spec.ts: a failed browser
	// test writes a DIRECTORY named `<spec>.ts`, and a scan matching on extension alone then
	// dies with EISDIR in a file that has nothing to do with the real failure.
	function sourceFilesUnder(root: string): string[] {
		return readdirSync(root, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => join(entry.parentPath, entry.name))
			.filter((path) => path.endsWith('.ts') || path.endsWith('.svelte'))
			.filter((path) => !path.includes(join('database', 'generated')))
			.filter((path) => !path.includes(join('lib', 'paraglide')));
	}

	// Specs are excluded because this very file writes `Cache-Control: no-store` into a fixture
	// two blocks up, and a scan that reads its own fixture reports the gap as closed while
	// nothing about the application changed.
	const APPLICATION_SOURCE = () =>
		sourceFilesUnder('src').filter(
			(path) => !path.endsWith('.spec.ts') && !path.endsWith('.db-smoke.ts')
		);

	it('are set nowhere in the application, and the scan can see a header when there is one', () => {
		expect.assertions(3);

		const files = APPLICATION_SOURCE();

		// Calibration, before any conclusion is drawn from an absence. A scan pointed at the
		// wrong directory, or one whose walker silently returned nothing, reports exactly the
		// same empty list as a clean codebase. A header string that IS present proves the walker
		// reached the source and the matcher works, so the two empty lists below mean absence.
		const control = files.filter((path) =>
			/X-Content-Type-Options/i.test(readFileSync(path, 'utf8'))
		);
		expect(control).not.toEqual([]);

		expect(files.filter((path) => /Cache-Control/i.test(readFileSync(path, 'utf8')))).toEqual([]);
		expect(files.filter((path) => /setHeaders/.test(readFileSync(path, 'utf8')))).toEqual([]);
	});

	// SCOPE, so this green is not read as a claim about the shipped server. It says the
	// APPLICATION sets no caching header. The artifact does send one: measured 2026-08-13,
	// `node build/index.js` serves `/_app/immutable/**` with
	// `cache-control: public,max-age=31536000,immutable`, from adapter-node's static middleware.
	// That is correct (content-hashed assets, no user data) and it is not ours, which is exactly
	// the distinction this scan draws and a response-level assertion could not.

	// v5.0.0-3.4.2, the application-wide half. The hook-level absence assertion above proves the
	// hook adds no CORS header; only a scan can say no route does either. It cannot be asserted
	// against the e2e server at all: vite's preview server adds `Access-Control-Allow-Origin: *`
	// itself, so the emitted header there is the harness talking, not the app. Measured
	// 2026-08-13: `vite preview` sends it, `node build/index.js` does not.
	it('v5.0.0-3.4.2: no CORS header is set anywhere in the application', () => {
		expect.assertions(2);

		const files = APPLICATION_SOURCE();

		const control = files.filter((path) => /Referrer-Policy/i.test(readFileSync(path, 'utf8')));
		expect(control).not.toEqual([]);

		expect(
			files.filter((path) => /Access-Control-Allow-/i.test(readFileSync(path, 'utf8')))
		).toEqual([]);
	});
});

// Que le header sorte bien sur une vraie réponse est vérifié contre un serveur qui tourne
// (`Vary: Accept-Language` + `Content-Language` sur /login et /register, mesurés) ; ce qu'un
// test unitaire apporte en plus, ce sont les règles de fusion, qui elles sont de la logique.
describe('hooks appendVary', () => {
	it('pose le champ quand aucun Vary n’existe', async () => {
		expect.assertions(1);
		const { appendVary } = await import('./hooks.server');

		const headers = new Headers();
		appendVary(headers, 'Accept-Language');

		expect(headers.get('Vary')).toBe('Accept-Language');
	});

	it('conserve un Vary déjà posé au lieu de l’écraser', async () => {
		expect.assertions(1);
		const { appendVary } = await import('./hooks.server');

		const headers = new Headers({ Vary: 'Cookie' });
		appendVary(headers, 'Accept-Language');

		expect(headers.get('Vary')).toBe('Cookie, Accept-Language');
	});

	it('ne duplique pas un champ déjà présent, quelle que soit la casse', async () => {
		expect.assertions(1);
		const { appendVary } = await import('./hooks.server');

		const headers = new Headers({ Vary: 'Cookie, accept-language' });
		appendVary(headers, 'Accept-Language');

		expect(headers.get('Vary')).toBe('Cookie, accept-language');
	});

	it('laisse « * » intact : il est déjà plus fort que n’importe quelle liste', async () => {
		expect.assertions(1);
		const { appendVary } = await import('./hooks.server');

		const headers = new Headers({ Vary: '*' });
		appendVary(headers, 'Accept-Language');

		expect(headers.get('Vary')).toBe('*');
	});
});

function buildEvent(pathname: string, token: string | undefined) {
	return {
		cookies: {
			get: vi.fn(() => token),
			delete: vi.fn()
		},
		locals: {},
		route: { id: pathname },
		url: new URL(`http://localhost${pathname}`)
	};
}

describe('originStartupMessage', () => {
	it('warns when ORIGIN is unset, naming the failure it predicts', async () => {
		const { originStartupMessage } = await import('./hooks.server');
		const message = originStartupMessage(undefined);
		expect(message).toMatch(/ORIGIN is unset/);
		expect(message).toMatch(/Cross-site POST form submissions are forbidden/);
		// The remedy belongs in the message, not only in the docs: this is the one variable whose
		// absence produced a user-visible failure with no boot signal at all.
		expect(message).toMatch(/Set ORIGIN to the exact URL you type/);
	});

	it('treats a blank ORIGIN as unset', async () => {
		const { originStartupMessage } = await import('./hooks.server');
		expect(originStartupMessage('   ')).toMatch(/ORIGIN is unset/);
	});

	it('reports the configured value, and still says what a wrong one costs', async () => {
		const { originStartupMessage } = await import('./hooks.server');
		const message = originStartupMessage('http://localhost:3999');
		expect(message).toContain('ORIGIN=http://localhost:3999');
		// Set-but-wrong is the likelier failure than unset: docker-compose.yml defaults ORIGIN to
		// http://localhost:3000, so moving APP_PORT alone produces exactly this state.
		expect(message).toMatch(/refused as cross-site/);
	});
});
