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
	areSecureCookiesEnabled,
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
	validateNewEmail,
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

	it('accepte une adresse de 254 caractères et rejette au-delà', () => {
		expect.assertions(2);

		// RFC 5321 caps an address at 254. This is the length the MySQL schema had to be widened
		// to accept (varchar(254)), so the app's own bound and the column's must agree exactly.
		const at254 = `${'a'.repeat(234)}@budgetpilot.invalid`;
		const at255 = `${'a'.repeat(235)}@budgetpilot.invalid`;

		expect(validateEmail(at254)).toBe(at254);
		expect(validateEmail(at255)).toBeNull();
	});

	it('refuse les caractères de contrôle, y compris à la connexion', () => {
		expect.assertions(3);

		// EMAIL_PATTERN's `[^\s@]` excludes whitespace but not NUL, so these used to reach the
		// user lookup. PostgreSQL rejects a NUL in a text parameter at the protocol level, which
		// turned a 400 into a 500 and skipped the failed-attempt record the rate limiter reads.
		expect(validateEmail('a\x00b@example.com')).toBeNull();
		expect(validateEmail('a\x1fb@example.com')).toBeNull();
		expect(validateEmail('a\x7fb@example.com')).toBeNull();
	});

	it("refuse une adresse non-ASCII à la création d'un compte", () => {
		expect.assertions(3);

		// MySQL reads User.email's unique index through utf8mb4_unicode_ci, which folds accents:
		// "café@" and "cafe@" are one row there and two on SQLite and PostgreSQL. Restricting
		// creation to ASCII means no two valid addresses can ever fold together.
		expect(validateNewEmail('cafe@example.com')).toBe('cafe@example.com');
		expect(validateNewEmail('café@example.com')).toBeNull();
		// Still a valid address as far as the shared rules go: only the ASCII rule rejects it.
		expect(validateEmail('café@example.com')).toBe('café@example.com');
	});

	it('laisse une adresse non-ASCII déjà enregistrée se connecter', () => {
		expect.assertions(1);

		// Deliberate asymmetry: the ASCII rule guards account creation only. Applying it to the
		// login lookup would lock an existing account out of a self-hosted finance app, which is
		// worse than the divergence it would close.
		expect(validateEmail('café@example.com')).not.toBeNull();
	});

	it('crée une session avec cookie opaque et hash uniquement stocké', async () => {
		expect.assertions(7);

		const cookieSet = vi.fn();
		db.prisma.session.create.mockResolvedValue({ id: 'session-1' });

		// Pinned explicitly: the secure flag now defaults to true whenever
		// PUBLIC_INSTANCE is anything but "false", so leaving it to the ambient
		// environment would make this assertion depend on the shell.
		const previousPublicInstance = process.env.PUBLIC_INSTANCE;
		process.env.PUBLIC_INSTANCE = 'false';
		try {
			await createSession('user-a', { set: cookieSet } as never);
		} finally {
			if (previousPublicInstance === undefined) delete process.env.PUBLIC_INSTANCE;
			else process.env.PUBLIC_INSTANCE = previousPublicInstance;
		}

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

	// The Secure flag is fail-secure: only the literal string "false" opts out.
	// Every other value (unset, empty, "true", a typo, "FALSE" with a different
	// case) must keep the flag on.
	const secureCookieCases: Array<[string | undefined, boolean]> = [
		[undefined, true],
		['', true],
		['true', true],
		['TRUE', true],
		['1', true],
		['ture', true],
		['FALSE', true],
		[' false ', true],
		['false', false]
	];

	it.each(secureCookieCases)(
		'PUBLIC_INSTANCE=%p => cookie secure %p (fail-secure, NODE_ENV ignoré)',
		(value, expected) => {
			expect.assertions(2);

			const previousPublicInstance = process.env.PUBLIC_INSTANCE;
			const previousNodeEnv = process.env.NODE_ENV;
			// NODE_ENV is pinned to development to prove it no longer takes part in
			// the decision: it used to force secure cookies on its own.
			process.env.NODE_ENV = 'development';
			if (value === undefined) delete process.env.PUBLIC_INSTANCE;
			else process.env.PUBLIC_INSTANCE = value;

			try {
				expect(areSecureCookiesEnabled()).toBe(expected);
				expect(getSessionCookieOptions(new Date()).secure).toBe(expected);
			} finally {
				if (previousPublicInstance === undefined) delete process.env.PUBLIC_INSTANCE;
				else process.env.PUBLIC_INSTANCE = previousPublicInstance;
				process.env.NODE_ENV = previousNodeEnv;
			}
		}
	);

	it('force le cookie secure quand NODE_ENV=production ET PUBLIC_INSTANCE absent', () => {
		expect.assertions(1);

		const previousPublicInstance = process.env.PUBLIC_INSTANCE;
		const previousNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'production';
		delete process.env.PUBLIC_INSTANCE;

		try {
			expect(areSecureCookiesEnabled()).toBe(true);
		} finally {
			if (previousPublicInstance === undefined) delete process.env.PUBLIC_INSTANCE;
			else process.env.PUBLIC_INSTANCE = previousPublicInstance;
			process.env.NODE_ENV = previousNodeEnv;
		}
	});

	it('laisse PUBLIC_INSTANCE=false désactiver le secure même en production (LAN)', () => {
		expect.assertions(1);

		const previousPublicInstance = process.env.PUBLIC_INSTANCE;
		const previousNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'production';
		process.env.PUBLIC_INSTANCE = 'false';

		try {
			expect(areSecureCookiesEnabled()).toBe(false);
		} finally {
			if (previousPublicInstance === undefined) delete process.env.PUBLIC_INSTANCE;
			else process.env.PUBLIC_INSTANCE = previousPublicInstance;
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
