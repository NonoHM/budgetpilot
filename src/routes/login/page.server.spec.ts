import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	prisma: {
		user: {
			// `load` calls isSelfRegistrationOpen(), which counts users. Non-zero so these cases
			// exercise an ordinary claimed instance rather than the bootstrap state.
			count: vi.fn(async () => 1),
			findUnique: vi.fn(),
			updateMany: vi.fn()
		},
		session: {
			create: vi.fn()
		},
		category: {
			findMany: vi.fn(),
			createMany: vi.fn()
		},
		categoryNatureMapping: {
			findMany: vi.fn(),
			createMany: vi.fn()
		}
	}
}));

const rateLimit = vi.hoisted(() => ({
	isLoginRateLimited: vi.fn(async () => false),
	recordFailedLoginAttempt: vi.fn(async () => undefined)
}));

const mfaChallenge = vi.hoisted(() => ({
	createMfaChallenge: vi.fn(async () => undefined)
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));
vi.mock('$lib/server/auth/rateLimit', () => rateLimit);
vi.mock('$lib/server/auth/mfaChallenge', () => mfaChallenge);

const { hashPassword } = await import('$lib/server/auth');
const { actions, load } = await import('./+page.server');

describe('/login action', () => {
	it('connecte avec un mot de passe valide sans retourner passwordHash', async () => {
		expect.assertions(5);

		const passwordHash = await hashPassword('mot-de-passe-long');
		db.prisma.user.findUnique.mockResolvedValue({ id: 'user-a', passwordHash });
		db.prisma.session.create.mockResolvedValue({ id: 'session-a' });
		// ensureDefaultCategoriesSeeded calls user.updateMany; count:0 = already seeded, no-op.
		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });
		const cookies = { set: vi.fn() };

		await expect(
			runLogin(cookies, {
				email: 'a@example.test',
				password: 'mot-de-passe-long'
			})
		).rejects.toMatchObject({ status: 303 });

		expect(db.prisma.user.findUnique).toHaveBeenCalledWith({
			where: { email: 'a@example.test' },
			select: { id: true, passwordHash: true, totpEnabled: true }
		});
		expect(cookies.set).toHaveBeenCalled();
		expect(JSON.stringify(db.prisma.session.create.mock.calls[0][0])).not.toContain(
			'mot-de-passe-long'
		);
		expect(JSON.stringify(db.prisma.session.create.mock.calls[0][0])).not.toContain(passwordHash);
	});

	it('échoue avec un message générique sur mauvais mot de passe et enregistre la tentative', async () => {
		expect.assertions(4);

		const passwordHash = await hashPassword('mot-de-passe-long');
		db.prisma.user.findUnique.mockResolvedValue({ id: 'user-a', passwordHash });

		const result = await runLogin(
			{ set: vi.fn() },
			{
				email: 'a@example.test',
				password: 'mauvais-mot-de-passe'
			}
		);

		expect(result.status).toBe(400);
		expect(result.data.error).toBe('Identifiants invalides');
		expect(JSON.stringify(result.data)).not.toContain('a@example.test');
		expect(rateLimit.recordFailedLoginAttempt).toHaveBeenCalledWith(
			'a@example.test',
			expect.any(String)
		);
	});

	it('échoue avec le même message générique pour un email inexistant (anti-énumération)', async () => {
		expect.assertions(2);

		db.prisma.user.findUnique.mockResolvedValue(null);

		const result = await runLogin(
			{ set: vi.fn() },
			{
				email: 'inconnu@example.test',
				password: 'peu-importe-le-mot-de-passe'
			}
		);

		expect(result.status).toBe(400);
		expect(result.data.error).toBe('Identifiants invalides');
	});

	it("normalise la casse de l'email pour la clé de rate-limit (même clé que la version minuscule)", async () => {
		expect.assertions(2);

		db.prisma.user.findUnique.mockResolvedValue(null);

		await runLogin(
			{ set: vi.fn() },
			{
				email: ' A@Example.TEST ',
				password: 'peu-importe-le-mot-de-passe'
			}
		);

		expect(rateLimit.isLoginRateLimited).toHaveBeenCalledWith('a@example.test', expect.any(String));
		expect(db.prisma.user.findUnique).toHaveBeenCalledWith({
			where: { email: 'a@example.test' },
			select: { id: true, passwordHash: true, totpEnabled: true }
		});
	});

	it('bloque après trop de tentatives sans révéler que le compte existe', async () => {
		expect.assertions(2);

		rateLimit.isLoginRateLimited.mockResolvedValueOnce(true);

		const result = await runLogin(
			{ set: vi.fn() },
			{
				email: 'a@example.test',
				password: 'peu-importe'
			}
		);

		expect(result.status).toBe(400);
		expect(result.data.error).toBe('Trop de tentatives. Réessayez dans quelques minutes.');
	});

	it('redirige vers /login/verify-totp sans créer de session quand le TOTP est actif', async () => {
		expect.assertions(4);
		vi.clearAllMocks();

		const passwordHash = await hashPassword('mot-de-passe-long');
		db.prisma.user.findUnique.mockResolvedValue({ id: 'user-a', passwordHash, totpEnabled: true });
		const cookies = { set: vi.fn() };

		await expect(
			runLogin(cookies, {
				email: 'a@example.test',
				password: 'mot-de-passe-long'
			})
		).rejects.toMatchObject({
			status: 303,
			location: expect.stringContaining('/login/verify-totp')
		});

		expect(mfaChallenge.createMfaChallenge).toHaveBeenCalledWith('user-a', cookies);
		expect(db.prisma.session.create).not.toHaveBeenCalled();
		expect(cookies.set).not.toHaveBeenCalled();
	});
});

async function runLogin(cookies: { set: ReturnType<typeof vi.fn> }, input: Record<string, string>) {
	const formData = new FormData();
	for (const [key, value] of Object.entries(input)) formData.set(key, value);

	return (await (
		actions.default as unknown as (event: {
			cookies: typeof cookies;
			getClientAddress: () => string;
			request: Request;
			url: URL;
		}) => Promise<unknown>
	)({
		cookies,
		getClientAddress: () => '127.0.0.1',
		request: new Request('http://localhost/login', {
			method: 'POST',
			body: formData
		}),
		url: new URL('http://localhost/login')
	})) as { status: number; data: { error: string } };
}

describe('/login load: the closed-registration notice', () => {
	// /register bounced here with nothing, and a silent bounce reads as a broken link rather than
	// as a policy. The reason travels in the query string now.
	it('surfaces the notice /register redirected with', async () => {
		expect.assertions(1);
		const result = await runLoad('http://localhost/login?notice=registration_closed');
		expect(result.notice).toBe('registration_closed');
	});

	it('is null when there is no notice', async () => {
		expect.assertions(1);
		const result = await runLoad('http://localhost/login');
		expect(result.notice).toBeNull();
	});

	// ALLOWLISTED, not reflected. The parameter selects a catalogue message and its value is never
	// rendered, because a reflected parameter above a real password field is how a phishing link
	// puts its own sentence on a page the visitor trusts.
	it.each([
		'<script>alert(1)</script>',
		'Your session expired, re-enter your card number',
		'registration_closed_extra'
	])('refuses an unknown notice value: %s', async (value) => {
		expect.assertions(1);
		const result = await runLoad(`http://localhost/login?notice=${encodeURIComponent(value)}`);
		expect(result.notice).toBeNull();
	});
});

async function runLoad(url: string): Promise<{ notice: string | null }> {
	return (await (
		load as unknown as (event: {
			locals: { user: null };
			url: URL;
		}) => Promise<{ notice: string | null }>
	)({ locals: { user: null }, url: new URL(url) })) as { notice: string | null };
}
