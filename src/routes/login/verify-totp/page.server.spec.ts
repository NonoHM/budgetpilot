import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
	process.env.TOTP_ENCRYPTION_KEY ??=
		'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'.slice(0, 64);
});

const db = vi.hoisted(() => ({
	prisma: {
		user: {
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
		},
		recoveryCode: {
			findMany: vi.fn(),
			updateMany: vi.fn()
		}
	}
}));

const mfaChallenge = vi.hoisted(() => ({
	readMfaChallenge: vi.fn(),
	consumeMfaChallenge: vi.fn(async () => undefined)
}));

const rateLimit = vi.hoisted(() => ({
	isMfaRateLimited: vi.fn(async () => false),
	recordMfaAttempt: vi.fn(async () => undefined)
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));
vi.mock('$lib/server/auth/mfaChallenge', () => mfaChallenge);
vi.mock('$lib/server/auth/rateLimit', () => rateLimit);

const { encryptTotpSecret, generateTotpSecretBase32, hashRecoveryCode } =
	await import('$lib/server/auth/totp');
const OTPAuth = await import('otpauth');
const { actions } = await import('./+page.server');

describe('/login/verify-totp action', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('crée une session et consomme le challenge sur code TOTP valide', async () => {
		expect.assertions(3);

		const secret = generateTotpSecretBase32();
		const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
		const code = totp.generate();

		mfaChallenge.readMfaChallenge.mockResolvedValue({ id: 'challenge-1', userId: 'user-a' });
		db.prisma.user.findUnique.mockResolvedValue({
			id: 'user-a',
			totpEnabled: true,
			totpSecretEncrypted: encryptTotpSecret(secret)
		});
		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });
		const cookies = { set: vi.fn() };

		await expect(runVerify(cookies, code)).rejects.toMatchObject({ status: 303 });

		expect(db.prisma.session.create).toHaveBeenCalledTimes(1);
		expect(mfaChallenge.consumeMfaChallenge).toHaveBeenCalledWith('challenge-1', cookies);
	});

	it('rejette un code invalide et enregistre la tentative de rate limiting', async () => {
		expect.assertions(3);

		mfaChallenge.readMfaChallenge.mockResolvedValue({ id: 'challenge-1', userId: 'user-a' });
		db.prisma.user.findUnique.mockResolvedValue({
			id: 'user-a',
			totpEnabled: true,
			totpSecretEncrypted: encryptTotpSecret(generateTotpSecretBase32())
		});

		const result = await runVerify({ set: vi.fn() }, '000000');

		expect(result.status).toBe(400);
		expect(db.prisma.session.create).not.toHaveBeenCalled();
		expect(rateLimit.recordMfaAttempt).toHaveBeenCalledWith('challenge-1', expect.any(String));
	});

	it('bloque après trop de tentatives', async () => {
		expect.assertions(1);

		mfaChallenge.readMfaChallenge.mockResolvedValue({ id: 'challenge-1', userId: 'user-a' });
		rateLimit.isMfaRateLimited.mockResolvedValueOnce(true);

		const result = await runVerify({ set: vi.fn() }, '123456');

		expect(result.status).toBe(400);
	});

	it('accepte un code de récupération valide, non réutilisable ensuite (marqué usedAt)', async () => {
		expect.assertions(3);

		const recoveryCode = 'ABCDE-12345';
		const codeHash = await hashRecoveryCode(recoveryCode);

		mfaChallenge.readMfaChallenge.mockResolvedValue({ id: 'challenge-1', userId: 'user-a' });
		db.prisma.user.findUnique.mockResolvedValue({
			id: 'user-a',
			totpEnabled: true,
			totpSecretEncrypted: encryptTotpSecret(generateTotpSecretBase32())
		});
		db.prisma.recoveryCode.findMany.mockResolvedValue([{ id: 'code-1', codeHash }]);
		db.prisma.recoveryCode.updateMany.mockResolvedValue({ count: 1 });
		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });

		await expect(runVerify({ set: vi.fn() }, recoveryCode)).rejects.toMatchObject({ status: 303 });

		expect(db.prisma.recoveryCode.updateMany).toHaveBeenCalledWith({
			where: { id: 'code-1', usedAt: null },
			data: { usedAt: expect.any(Date) }
		});
		expect(db.prisma.session.create).toHaveBeenCalledTimes(1);
	});

	it('accepte un code de récupération saisi en minuscules (les codes sont générés en majuscules)', async () => {
		expect.assertions(1);

		const recoveryCode = 'ABCDE-12345';
		const codeHash = await hashRecoveryCode(recoveryCode);

		mfaChallenge.readMfaChallenge.mockResolvedValue({ id: 'challenge-1', userId: 'user-a' });
		db.prisma.user.findUnique.mockResolvedValue({
			id: 'user-a',
			totpEnabled: true,
			totpSecretEncrypted: encryptTotpSecret(generateTotpSecretBase32())
		});
		db.prisma.recoveryCode.findMany.mockResolvedValue([{ id: 'code-1', codeHash }]);
		db.prisma.recoveryCode.updateMany.mockResolvedValue({ count: 1 });
		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });

		await expect(runVerify({ set: vi.fn() }, recoveryCode.toLowerCase())).rejects.toMatchObject({
			status: 303
		});
	});

	it('rejette un code TOTP dont le secret a été chiffré avec une clé différente (échec de déchiffrement) sans planter', async () => {
		expect.assertions(2);

		mfaChallenge.readMfaChallenge.mockResolvedValue({ id: 'challenge-1', userId: 'user-a' });
		db.prisma.user.findUnique.mockResolvedValue({
			id: 'user-a',
			totpEnabled: true,
			totpSecretEncrypted: 'not-a-valid-encrypted-payload'
		});

		const result = await runVerify({ set: vi.fn() }, '123456');

		expect(result.status).toBe(400);
		expect(rateLimit.recordMfaAttempt).toHaveBeenCalledWith('challenge-1', expect.any(String));
	});

	it('redirige vers /login sans challenge valide', async () => {
		expect.assertions(1);

		mfaChallenge.readMfaChallenge.mockResolvedValue(null);

		await expect(runVerify({ set: vi.fn() }, '123456')).rejects.toMatchObject({
			status: 303,
			location: '/login'
		});
	});
});

async function runVerify(cookies: { set: ReturnType<typeof vi.fn> }, code: string) {
	const formData = new FormData();
	formData.set('code', code);

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
		request: new Request('http://localhost/login/verify-totp', {
			method: 'POST',
			body: formData
		}),
		url: new URL('http://localhost/login/verify-totp')
	})) as { status: number; data: { error: string } };
}
