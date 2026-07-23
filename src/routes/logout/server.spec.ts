import { describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
	clearSessionCookie: vi.fn(),
	revokeSessionToken: vi.fn(),
	SESSION_COOKIE: 'budgetpilot_session'
}));

vi.mock('$lib/server/auth', () => auth);

const { POST } = await import('./+server');

describe('/logout', () => {
	it('révoque la session et supprime le cookie', async () => {
		expect.assertions(3);

		const cookies = {
			get: vi.fn(() => 'token-secret')
		};

		await expect(POST({ cookies } as never)).rejects.toMatchObject({
			status: 303,
			location: '/login'
		});

		expect(auth.revokeSessionToken).toHaveBeenCalledWith('token-secret');
		expect(auth.clearSessionCookie).toHaveBeenCalledWith(cookies);
	});
});
