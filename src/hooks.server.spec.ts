import { describe, expect, it, vi } from 'vitest';

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
