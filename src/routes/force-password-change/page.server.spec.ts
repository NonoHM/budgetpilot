import { beforeEach, describe, expect, it, vi } from 'vitest';

const tx = vi.hoisted(() => ({
	user: {
		update: vi.fn()
	},
	session: {
		updateMany: vi.fn()
	}
}));

const db = vi.hoisted(() => ({
	prisma: {
		$transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));
// The commit rotates the session token in the same transaction (#249); its own behaviour is
// `sessionRotation.db-smoke.ts`'s, against a real engine. Here it runs the change on the fake
// transaction, so these tests can say which session it commits for and that the writes are inside it.
vi.mock('$lib/server/auth', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/auth')>();
	type Change = (client: typeof tx) => Promise<unknown>;
	return {
		...real,
		commitWithRotatedToken: vi.fn(async (_user: unknown, _cookies: unknown, change: Change) =>
			db.prisma.$transaction(change)
		)
	};
});

const { commitWithRotatedToken, SESSION_COOKIE } = await import('$lib/server/auth');
const { actions, load } = await import('./+page.server');

describe('/force-password-change load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.prisma.$transaction.mockImplementation(async (callback) => callback(tx));
	});

	it('redirige vers /login si aucun utilisateur connecté', async () => {
		expect.assertions(1);

		await expect(
			(load as unknown as (event: { locals: { user: null } }) => Promise<unknown>)({
				locals: { user: null }
			})
		).rejects.toMatchObject({ status: 303, location: '/login' });
	});

	it('redirige vers / si forcePasswordChange est déjà false (rien à faire)', async () => {
		expect.assertions(1);

		await expect(
			(
				load as unknown as (event: {
					locals: { user: { forcePasswordChange: boolean } };
				}) => Promise<unknown>
			)({
				locals: { user: { forcePasswordChange: false } }
			})
		).rejects.toMatchObject({ status: 303, location: '/' });
	});

	it('laisse passer si forcePasswordChange est true', async () => {
		expect.assertions(1);

		const result = await (
			load as unknown as (event: {
				locals: { user: { forcePasswordChange: boolean } };
			}) => Promise<unknown>
		)({
			locals: { user: { forcePasswordChange: true } }
		});

		expect(result).toEqual({});
	});
});

describe('/force-password-change action', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.prisma.$transaction.mockImplementation(async (callback) => callback(tx));
	});

	it('rejette si newPassword et confirmPassword ne correspondent pas', async () => {
		expect.assertions(2);

		const result = await runAction({
			newPassword: 'mot-de-passe-long-1',
			confirmPassword: 'mot-de-passe-different'
		});

		expect(result.status).toBe(400);
		expect(tx.user.update).not.toHaveBeenCalled();
	});

	// A refused input leaves the browser's token alone: the owner retypes on the same session.
	it('a refused new password does not rotate the token', async () => {
		expect.assertions(2);

		const result = await runAction({ newPassword: 'trop-court', confirmPassword: 'trop-court' });

		expect(result.status).toBe(400);
		expect(commitWithRotatedToken).not.toHaveBeenCalled();
	});

	it('rejette un mot de passe trop court même si confirmé correctement', async () => {
		expect.assertions(2);

		const result = await runAction({
			newPassword: 'trop-court',
			confirmPassword: 'trop-court'
		});

		expect(result.status).toBe(400);
		expect(tx.user.update).not.toHaveBeenCalled();
	});

	it('met à jour le mot de passe, désactive forcePasswordChange, révoque les autres sessions et garde la session courante', async () => {
		expect.assertions(8);

		tx.user.update.mockResolvedValue({ id: 'user-a' });
		tx.session.updateMany.mockResolvedValue({ count: 2 });
		const currentToken = 'session-courante';

		await expect(
			runAction(
				{
					newPassword: 'nouveau-mot-de-passe-solide',
					confirmPassword: 'nouveau-mot-de-passe-solide'
				},
				currentToken
			)
		).rejects.toMatchObject({ status: 303, location: '/' });

		const updateArgs = tx.user.update.mock.calls[0][0];
		expect(updateArgs.where).toEqual({ id: 'user-a' });
		expect(updateArgs.data.forcePasswordChange).toBe(false);
		expect(updateArgs.data.passwordHash).not.toBe('nouveau-mot-de-passe-solide');
		// The current session is spared by its ROW, which the rotation in the same commit keeps; a
		// token hash would no longer match it once rotated (#249).
		expect(tx.session.updateMany).toHaveBeenCalledWith({
			where: {
				userId: 'user-a',
				revokedAt: null,
				id: { not: 'session-a' }
			},
			data: { revokedAt: expect.any(Date) }
		});
		expect(vi.mocked(commitWithRotatedToken)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(commitWithRotatedToken).mock.calls[0]?.[0]).toMatchObject({
			sessionId: 'session-a'
		});
		expect(JSON.stringify(tx.user.update.mock.calls[0][0])).not.toContain(
			'nouveau-mot-de-passe-solide'
		);
	});

	// Every write is INSIDE the rotating commit, so a session that ended before it commits sets no
	// password. Separates « written inside the commit » from « written beside it », which would land
	// the new password for a session that is already over. The commit here refuses without running
	// the change, which is what the real one leaves behind: its compare-and-set rolls the change back.
	it('a session that ended during the request writes no password', async () => {
		expect.assertions(2);
		const ended = new Error('session ended');
		vi.mocked(commitWithRotatedToken).mockRejectedValueOnce(ended);

		await expect(
			runAction({
				newPassword: 'nouveau-mot-de-passe-solide',
				confirmPassword: 'nouveau-mot-de-passe-solide'
			})
		).rejects.toBe(ended);
		expect(tx.user.update).not.toHaveBeenCalled();
	});
});

function buildCookies(token?: string) {
	return {
		get: vi.fn((name: string) => (name === SESSION_COOKIE ? token : undefined)),
		set: vi.fn(),
		delete: vi.fn()
	};
}

async function runAction(input: Record<string, string>, token = 'session-courante') {
	const formData = new FormData();
	for (const [key, value] of Object.entries(input)) formData.set(key, value);

	return (await (
		actions.default as unknown as (event: {
			cookies: ReturnType<typeof buildCookies>;
			locals: { user: { id: string; sessionId: string; forcePasswordChange: boolean } };
			request: Request;
		}) => Promise<unknown>
	)({
		cookies: buildCookies(token),
		locals: { user: { id: 'user-a', sessionId: 'session-a', forcePasswordChange: true } },
		request: new Request('http://localhost/force-password-change', {
			method: 'POST',
			body: formData
		})
	})) as { status: number; data: { passwordError?: string } };
}
