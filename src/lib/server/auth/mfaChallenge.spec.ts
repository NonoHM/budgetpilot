import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	prisma: {
		pendingMfaChallenge: {
			create: vi.fn(),
			findUnique: vi.fn(),
			deleteMany: vi.fn()
		}
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { createMfaChallenge, readMfaChallenge, consumeMfaChallenge, MFA_PENDING_COOKIE } =
	await import('./mfaChallenge');
const { hashSessionToken } = await import('$lib/server/auth');

function fakeCookies() {
	const store = new Map<string, string>();
	return {
		set: vi.fn((name: string, value: string) => {
			store.set(name, value);
		}),
		get: vi.fn((name: string) => store.get(name)),
		delete: vi.fn((name: string) => {
			store.delete(name);
		})
	};
}

describe('createMfaChallenge', () => {
	it('pose un cookie httpOnly contenant un token opaque, jamais le userId', async () => {
		expect.assertions(4);

		db.prisma.pendingMfaChallenge.deleteMany.mockResolvedValue({ count: 0 });
		db.prisma.pendingMfaChallenge.create.mockResolvedValue({ id: 'challenge-1' });
		const cookies = fakeCookies();

		await createMfaChallenge('user-a', cookies as never);

		expect(cookies.set).toHaveBeenCalledWith(
			MFA_PENDING_COOKIE,
			expect.any(String),
			expect.objectContaining({ httpOnly: true, sameSite: 'lax' })
		);
		const [, token] = cookies.set.mock.calls[0];
		expect(token).not.toBe('user-a');

		const createArgs = db.prisma.pendingMfaChallenge.create.mock.calls[0][0];
		expect(createArgs.data.userId).toBe('user-a');
		expect(createArgs.data.tokenHash).toBe(hashSessionToken(token));
	});
});

describe('readMfaChallenge', () => {
	it('retourne null sans cookie', async () => {
		expect.assertions(1);
		const cookies = fakeCookies();
		await expect(readMfaChallenge(cookies as never)).resolves.toBeNull();
	});

	it('retourne null si le challenge est expiré', async () => {
		expect.assertions(1);
		const cookies = fakeCookies();
		cookies.get.mockReturnValue('some-token');
		db.prisma.pendingMfaChallenge.findUnique.mockResolvedValue({
			id: 'challenge-1',
			userId: 'user-a',
			expiresAt: new Date(Date.now() - 1000)
		});

		await expect(readMfaChallenge(cookies as never)).resolves.toBeNull();
	});

	it('retourne id/userId pour un challenge valide', async () => {
		expect.assertions(1);
		const cookies = fakeCookies();
		cookies.get.mockReturnValue('some-token');
		db.prisma.pendingMfaChallenge.findUnique.mockResolvedValue({
			id: 'challenge-1',
			userId: 'user-a',
			expiresAt: new Date(Date.now() + 1000)
		});

		await expect(readMfaChallenge(cookies as never)).resolves.toEqual({
			id: 'challenge-1',
			userId: 'user-a'
		});
	});
});

describe('consumeMfaChallenge', () => {
	it('supprime le challenge et efface le cookie', async () => {
		expect.assertions(2);
		db.prisma.pendingMfaChallenge.deleteMany.mockResolvedValue({ count: 1 });
		const cookies = fakeCookies();

		await consumeMfaChallenge('challenge-1', cookies as never);

		expect(db.prisma.pendingMfaChallenge.deleteMany).toHaveBeenCalledWith({
			where: { id: 'challenge-1' }
		});
		expect(cookies.delete).toHaveBeenCalledWith(MFA_PENDING_COOKIE, { path: '/' });
	});
});
