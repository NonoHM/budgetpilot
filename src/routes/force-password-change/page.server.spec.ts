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

const { hashSessionToken, SESSION_COOKIE } = await import('$lib/server/auth');
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
		expect.assertions(6);

		tx.user.update.mockResolvedValue({ id: 'user-a' });
		tx.session.updateMany.mockResolvedValue({ count: 2 });
		const currentToken = 'session-courante';
		const currentTokenHash = hashSessionToken(currentToken);

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
		expect(tx.session.updateMany).toHaveBeenCalledWith({
			where: {
				userId: 'user-a',
				revokedAt: null,
				tokenHash: { not: currentTokenHash }
			},
			data: { revokedAt: expect.any(Date) }
		});
		expect(JSON.stringify(tx.user.update.mock.calls[0][0])).not.toContain(
			'nouveau-mot-de-passe-solide'
		);
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
			locals: { user: { id: string; forcePasswordChange: boolean } };
			request: Request;
		}) => Promise<unknown>
	)({
		cookies: buildCookies(token),
		locals: { user: { id: 'user-a', forcePasswordChange: true } },
		request: new Request('http://localhost/force-password-change', {
			method: 'POST',
			body: formData
		})
	})) as { status: number; data: { passwordError?: string } };
}
