import bcrypt from 'bcrypt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	prisma: {
		session: {
			create: vi.fn(),
			findUnique: vi.fn(),
			updateMany: vi.fn()
		}
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const {
	createSession,
	generateTemporaryPassword,
	getSessionCookieOptions,
	hashPassword,
	hashSessionToken,
	readSessionUser,
	requireAdmin,
	requireUser,
	revokeSessionToken,
	SESSION_COOKIE,
	validateEmail,
	validatePassword,
	verifyPasswordTimingSafe
} = await import('./auth');

describe('auth locale', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('hash les mots de passe avec bcrypt cost 12', async () => {
		expect.assertions(3);

		const passwordHash = await hashPassword('mot-de-passe-long');

		expect(passwordHash).not.toBe('mot-de-passe-long');
		expect(passwordHash).toMatch(/^\$2[aby]\$/);
		expect(bcrypt.getRounds(passwordHash)).toBe(12);
	});

	it('valide email et mot de passe côté serveur', () => {
		expect.assertions(4);

		expect(validateEmail(' USER@Example.COM ')).toBe('user@example.com');
		expect(validateEmail('not-an-email')).toBeNull();
		expect(validatePassword('123456789012')).toBe(true);
		expect(validatePassword('too-short')).toBe(false);
	});

	it('crée une session avec cookie opaque et hash uniquement stocké', async () => {
		expect.assertions(7);

		const cookieSet = vi.fn();
		db.prisma.session.create.mockResolvedValue({ id: 'session-1' });

		await createSession('user-a', { set: cookieSet } as never);

		const createArgs = db.prisma.session.create.mock.calls[0][0];
		const cookieArgs = cookieSet.mock.calls[0];
		expect(createArgs.data.userId).toBe('user-a');
		expect(createArgs.data.tokenHash).toHaveLength(64);
		expect(createArgs.data.tokenHash).not.toBe(cookieArgs[1]);
		expect(cookieArgs[0]).toBe(SESSION_COOKIE);
		expect(cookieArgs[2]).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
		expect(cookieArgs[2].secure).toBe(false);
		expect(cookieArgs[2].expires).toBeInstanceOf(Date);
	});

	it('charge seulement un utilisateur minimal depuis une session valide', async () => {
		expect.assertions(2);

		const token = 'opaque-session-token';
		db.prisma.session.findUnique.mockResolvedValue({
			tokenHash: hashSessionToken(token),
			expiresAt: new Date(Date.now() + 60_000),
			revokedAt: null,
			user: {
				id: 'user-a',
				email: 'a@example.test',
				role: 'USER'
			}
		});

		const user = await readSessionUser(token);

		expect(user).toEqual({ id: 'user-a', email: 'a@example.test', role: 'USER' });
		expect(JSON.stringify(user)).not.toContain('passwordHash');
	});

	it('rejette une session révoquée ou expirée', async () => {
		expect.assertions(2);

		const token = 'opaque-session-token';
		db.prisma.session.findUnique
			.mockResolvedValueOnce({
				tokenHash: hashSessionToken(token),
				expiresAt: new Date(Date.now() + 60_000),
				revokedAt: new Date(),
				user: {
					id: 'user-a',
					email: 'a@example.test',
					role: 'USER'
				}
			})
			.mockResolvedValueOnce({
				tokenHash: hashSessionToken(token),
				expiresAt: new Date(Date.now() - 60_000),
				revokedAt: null,
				user: {
					id: 'user-a',
					email: 'a@example.test',
					role: 'USER'
				}
			});

		await expect(readSessionUser(token)).resolves.toBeNull();
		await expect(readSessionUser(token)).resolves.toBeNull();
	});

	it('révoque une session par hash de token', async () => {
		expect.assertions(2);

		await revokeSessionToken('token-secret');

		expect(db.prisma.session.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					tokenHash: hashSessionToken('token-secret'),
					revokedAt: null
				}
			})
		);
		expect(JSON.stringify(db.prisma.session.updateMany.mock.calls[0][0])).not.toContain(
			'token-secret'
		);
	});

	it('configure le cookie de session HttpOnly SameSite=Lax', () => {
		expect.assertions(4);

		const options = getSessionCookieOptions(new Date('2026-07-01T00:00:00.000Z'));

		expect(options.httpOnly).toBe(true);
		expect(options.sameSite).toBe('lax');
		expect(options.path).toBe('/');
		expect(options.expires.toISOString()).toBe('2026-07-01T00:00:00.000Z');
	});

	it("PUBLIC_INSTANCE=true force le cookie secure même si NODE_ENV n'est pas production", () => {
		expect.assertions(1);

		const previousPublicInstance = process.env.PUBLIC_INSTANCE;
		const previousNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'development';
		process.env.PUBLIC_INSTANCE = 'true';

		try {
			expect(getSessionCookieOptions(new Date()).secure).toBe(true);
		} finally {
			process.env.PUBLIC_INSTANCE = previousPublicInstance;
			process.env.NODE_ENV = previousNodeEnv;
		}
	});

	it('vérifie un mot de passe factice quand le hash est absent (anti-timing)', async () => {
		expect.assertions(2);

		await expect(verifyPasswordTimingSafe('n-importe-quoi', undefined)).resolves.toBe(false);

		const passwordHash = await hashPassword('mot-de-passe-long');
		await expect(verifyPasswordTimingSafe('mot-de-passe-long', passwordHash)).resolves.toBe(true);
	});

	it('rejette un mauvais mot de passe comparé à un hash existant', async () => {
		expect.assertions(1);

		const passwordHash = await hashPassword('mot-de-passe-long');

		await expect(verifyPasswordTimingSafe('mauvais-mot-de-passe', passwordHash)).resolves.toBe(
			false
		);
	});

	it('requireUser redirige vers /login si aucun utilisateur', () => {
		expect.assertions(1);

		expect(() => requireUser(null)).toThrowError(
			expect.objectContaining({ status: 303, location: '/login' })
		);
	});

	it('requireUser retourne l’utilisateur si présent', () => {
		expect.assertions(1);

		const user = {
			id: 'user-a',
			email: 'a@example.test',
			role: 'USER',
			forcePasswordChange: false
		} as const;

		expect(requireUser(user)).toBe(user);
	});

	it('requireAdmin redirige vers /login si aucun utilisateur (même garde que requireUser)', () => {
		expect.assertions(1);

		expect(() => requireAdmin(null)).toThrowError(
			expect.objectContaining({ status: 303, location: '/login' })
		);
	});

	it('requireAdmin rejette un utilisateur non-admin avec un 403', () => {
		expect.assertions(1);

		const user = {
			id: 'user-a',
			email: 'a@example.test',
			role: 'USER',
			forcePasswordChange: false
		} as const;

		expect(() => requireAdmin(user)).toThrowError(expect.objectContaining({ status: 403 }));
	});

	it('requireAdmin retourne l’utilisateur si son rôle est ADMIN', () => {
		expect.assertions(1);

		const admin = {
			id: 'admin-a',
			email: 'admin@example.test',
			role: 'ADMIN',
			forcePasswordChange: false
		} as const;

		expect(requireAdmin(admin)).toBe(admin);
	});

	it('generateTemporaryPassword() produit toujours un mot de passe accepté par validatePassword()', () => {
		expect.assertions(20);

		for (let i = 0; i < 20; i += 1) {
			expect(validatePassword(generateTemporaryPassword())).toBe(true);
		}
	});

	it('generateTemporaryPassword() génère des valeurs différentes à chaque appel (aléatoire, pas un mot de passe figé)', () => {
		expect.assertions(1);

		const passwords = new Set(Array.from({ length: 10 }, () => generateTemporaryPassword()));

		expect(passwords.size).toBe(10);
	});
});
