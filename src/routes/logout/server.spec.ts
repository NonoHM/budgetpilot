import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
	clearSessionCookie: vi.fn(),
	revokeSession: vi.fn()
}));

vi.mock('$lib/server/auth', () => auth);

const { POST } = await import('./+server');

describe('/logout', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// #249: by the session the hook resolved, not by the token presented. Separates « ends the
	// session » from « ends a token », which a concurrent re-authenticated change in another tab may
	// already have replaced: the logout would then end nothing (against a real engine in
	// `sessionRotation.db-smoke.ts`).
	it('revokes the resolved session by its id and clears the cookie', async () => {
		expect.assertions(3);

		const cookies = {
			get: vi.fn(() => 'token-secret')
		};

		await expect(
			POST({ cookies, locals: { user: { id: 'user-a', sessionId: 'session-a' } } } as never)
		).rejects.toMatchObject({
			status: 303,
			location: '/login'
		});

		expect(auth.revokeSession).toHaveBeenCalledWith('session-a');
		expect(auth.clearSessionCookie).toHaveBeenCalledWith(cookies);
	});
});
