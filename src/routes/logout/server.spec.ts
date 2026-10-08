import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTRIBUTE, EVENT } from '$lib/server/logging/names';

vi.hoisted(() => {
	process.env.RATE_LIMIT_HASH_SECRET ??= 'a1'.repeat(32);
});

const logged = vi.hoisted(() => [] as unknown[]);
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: (event: unknown) => {
		logged.push(event);
	}
}));

// The log pseudonyms import the limiter, which imports the database; nothing here queries it.
vi.mock('$lib/server/db', () => ({ prisma: {} }));

const auth = vi.hoisted(() => ({
	clearSessionCookie: vi.fn(),
	revokeSession: vi.fn()
}));

vi.mock('$lib/server/auth', () => auth);

const { POST } = await import('./+server');
const pseudonym = await import('$lib/server/logging/pseudonym');

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

/**
 * A logout is one security event naming the user by pseudonym, and no address (L3 contract): the
 * session already identifies the client, and the line is not an attack.
 */
describe('/logout: security events (L3)', () => {
	const signedIn = { user: { id: 'user-a', sessionId: 'session-a' } };

	beforeEach(() => {
		vi.clearAllMocks();
		logged.length = 0;
	});

	async function logout(locals: unknown): Promise<unknown> {
		const cookies = { get: vi.fn(() => 'token-secret') };
		return (POST({ cookies, locals } as never) as Promise<unknown>).then(
			() => 'returned',
			(thrown: { status?: number }) => thrown.status
		);
	}

	it('a live session logs one logout naming the user by pseudonym', async () => {
		const status = await logout(signedIn);
		expect({ status, logged }).toEqual({
			status: 303,
			logged: [
				{
					event: EVENT.authnLogout,
					attributes: { [ATTRIBUTE.userPseudonym]: pseudonym.logUserPseudonym('user-a') }
				}
			]
		});
	});

	// The first element calibrates the reading: a key the line carries does read as present.
	it('a logout carries no address, no subnet label and no width', async () => {
		await logout(signedIn);
		expect(
			logged.map((event) => {
				const attributes = (event as { attributes: Record<string, unknown> }).attributes;
				return [
					Object.hasOwn(attributes, ATTRIBUTE.userPseudonym),
					Object.hasOwn(attributes, ATTRIBUTE.clientPseudonym),
					Object.hasOwn(attributes, ATTRIBUTE.clientSubnetPseudonym),
					Object.hasOwn(attributes, ATTRIBUTE.clientSubnetPrefixLength)
				];
			})
		).toEqual([[true, false, false, false]]);
	});

	it('a request with no session logs nothing', async () => {
		const status = await logout({ user: null });
		expect({ status, logged }).toEqual({ status: 303, logged: [] });
	});
});
