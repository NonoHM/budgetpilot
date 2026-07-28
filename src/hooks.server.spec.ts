import { afterEach, describe, expect, it, vi } from 'vitest';

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

// handleSecurityHeaders captures `secureCookies` in a module-level const, evaluated once
// at import time from areSecureCookiesEnabled() — so each case needs a fresh module
// instance (vi.resetModules) with the mock's return value set beforehand, same pattern as
// bootstrapToken.spec.ts's boot guard. The pre-imported `handle`/`handleAuth` above stay
// bound to the module instance captured before any of these resets, so they're unaffected.
describe('hooks handleSecurityHeaders', () => {
	afterEach(() => {
		auth.areSecureCookiesEnabled.mockReturnValue(false);
	});

	it('sets X-Frame-Options, X-Content-Type-Options and Referrer-Policy regardless of secure-cookie state', async () => {
		expect.assertions(3);

		auth.areSecureCookiesEnabled.mockReturnValue(false);
		vi.resetModules();
		const { handleSecurityHeaders } = await import('./hooks.server');

		const response = await handleSecurityHeaders({
			event: {} as never,
			resolve: vi.fn(async () => new Response('ok'))
		} as never);

		expect(response.headers.get('X-Frame-Options')).toBe('DENY');
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(response.headers.get('Referrer-Policy')).toBe('same-origin');
	});

	it('adds Strict-Transport-Security when secure cookies are enabled at boot (PUBLIC_INSTANCE fail-secure default)', async () => {
		expect.assertions(1);

		auth.areSecureCookiesEnabled.mockReturnValue(true);
		vi.resetModules();
		const { handleSecurityHeaders } = await import('./hooks.server');

		const response = await handleSecurityHeaders({
			event: {} as never,
			resolve: vi.fn(async () => new Response('ok'))
		} as never);

		expect(response.headers.get('Strict-Transport-Security')).toBe(
			'max-age=15552000; includeSubDomains'
		);
	});

	it('omits Strict-Transport-Security when secure cookies are disabled (PUBLIC_INSTANCE=false, plain-HTTP LAN)', async () => {
		expect.assertions(1);

		auth.areSecureCookiesEnabled.mockReturnValue(false);
		vi.resetModules();
		const { handleSecurityHeaders } = await import('./hooks.server');

		const response = await handleSecurityHeaders({
			event: {} as never,
			resolve: vi.fn(async () => new Response('ok'))
		} as never);

		expect(response.headers.get('Strict-Transport-Security')).toBeNull();
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
