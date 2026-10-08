import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTRIBUTE, EVENT } from '$lib/server/logging/names';

vi.hoisted(() => {
	process.env.TOTP_ENCRYPTION_KEY ??=
		'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'.slice(0, 64);
	process.env.RATE_LIMIT_HASH_SECRET ??= 'a1'.repeat(32);
});

/** Every line the action writes, and the order of each line against the limiter's record. */
const captured = vi.hoisted(() => ({ events: [] as unknown[], order: [] as string[] }));
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: (event: unknown) => {
		captured.events.push(event);
		captured.order.push('log');
	}
}));

const db = vi.hoisted(() => {
	const prisma = {
		user: {
			findUnique: vi.fn(),
			updateMany: vi.fn(),
			// The account's factor is unchanged since it was read (#818): a refused step is a spent one.
			count: vi.fn(async () => 1)
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
		},
		// `createSession` writes inside a transaction (#923); the fake runs it against itself.
		$transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(prisma))
	};
	return { prisma };
});

const mfaChallenge = vi.hoisted(() => ({
	readMfaChallenge: vi.fn(),
	// The claim runs inside the session's transaction (#923); here it succeeds, and what the route
	// does with a refused one is the sign-in's to answer.
	claimMfaChallenge: vi.fn(async () => undefined),
	clearMfaChallengeCookie: vi.fn(),
	consumeMfaChallenge: vi.fn(async () => undefined)
}));

const rateLimit = vi.hoisted(() => ({
	isMfaRateLimited: vi.fn(async () => false),
	recordMfaAttempt: vi.fn(async () => {
		captured.order.push('record');
	})
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));
vi.mock('$lib/server/auth/mfaChallenge', () => mfaChallenge);
// The rest of the module stays real: the log pseudonyms read the limiter's secret and prefix.
vi.mock('$lib/server/auth/rateLimit', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/auth/rateLimit')>()),
	...rateLimit
}));

const { encryptTotpSecret, generateTotpSecretBase32, hashRecoveryCode } =
	await import('$lib/server/auth/totp');
const OTPAuth = await import('otpauth');
const m = await import('$lib/paraglide/messages');
const { actions } = await import('./+page.server');
const { SignInSuperseded } = await import('$lib/server/auth');
const pseudonym = await import('$lib/server/logging/pseudonym');

/**
 * `user.updateMany` answers two different claims in this route: the TOTP step (#818), and the
 * default-seeding claims, answered « already seeded » so a sign-in writes no defaults here.
 */
function userClaims({ totpStepMatches }: { totpStepMatches: boolean }) {
	db.prisma.user.updateMany.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
		count: 'totpLastUsedStep' in args.data && totpStepMatches ? 1 : 0
	}));
}

describe('/login/verify-totp action', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('crée une session et consomme le challenge sur code TOTP valide', async () => {
		expect.assertions(4);

		const secret = generateTotpSecretBase32();
		const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
		const code = totp.generate();

		mfaChallenge.readMfaChallenge.mockResolvedValue({ id: 'challenge-1', userId: 'user-a' });
		db.prisma.user.findUnique.mockResolvedValue({
			id: 'user-a',
			totpEnabled: true,
			totpSecretEncrypted: encryptTotpSecret(secret)
		});
		userClaims({ totpStepMatches: true });
		const cookies = { get: vi.fn(), set: vi.fn() };

		await expect(runVerify(cookies, code)).rejects.toMatchObject({ status: 303 });

		expect(db.prisma.session.create).toHaveBeenCalledTimes(1);
		expect(mfaChallenge.claimMfaChallenge).toHaveBeenCalledWith(expect.anything(), 'challenge-1');
		expect(mfaChallenge.clearMfaChallengeCookie).toHaveBeenCalledWith(cookies);
	});

	// #818: a valid code whose step was already accepted. Whether the step WAS accepted is the
	// engine's to decide (`totpSingleUse.db-smoke.ts`); here the fake says so, and what is under test
	// is what the route does with the answer: the reason, no session, an attempt counted.
	it('refuses a code already used with its own sentence, and signs nobody in', async () => {
		expect.assertions(4);

		const secret = generateTotpSecretBase32();
		const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
		mfaChallenge.readMfaChallenge.mockResolvedValue({ id: 'challenge-1', userId: 'user-a' });
		db.prisma.user.findUnique.mockResolvedValue({
			id: 'user-a',
			totpEnabled: true,
			totpSecretEncrypted: encryptTotpSecret(secret)
		});
		userClaims({ totpStepMatches: false });

		const result = await runVerify({ get: vi.fn(), set: vi.fn() }, code);

		expect(result.status).toBe(400);
		expect(result.data).toEqual({ error: m.totp_error_code_reused() });
		expect(db.prisma.session.create).not.toHaveBeenCalled();
		expect(rateLimit.recordMfaAttempt).toHaveBeenCalledWith('challenge-1', expect.any(String));
	});

	it('rejette un code invalide et enregistre la tentative de rate limiting', async () => {
		expect.assertions(3);

		mfaChallenge.readMfaChallenge.mockResolvedValue({ id: 'challenge-1', userId: 'user-a' });
		db.prisma.user.findUnique.mockResolvedValue({
			id: 'user-a',
			totpEnabled: true,
			totpSecretEncrypted: encryptTotpSecret(generateTotpSecretBase32())
		});

		const result = await runVerify({ get: vi.fn(), set: vi.fn() }, '000000');

		expect(result.status).toBe(400);
		expect(db.prisma.session.create).not.toHaveBeenCalled();
		expect(rateLimit.recordMfaAttempt).toHaveBeenCalledWith('challenge-1', expect.any(String));
	});

	it('bloque après trop de tentatives', async () => {
		expect.assertions(1);

		mfaChallenge.readMfaChallenge.mockResolvedValue({ id: 'challenge-1', userId: 'user-a' });
		rateLimit.isMfaRateLimited.mockResolvedValueOnce(true);

		const result = await runVerify({ get: vi.fn(), set: vi.fn() }, '123456');

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

		await expect(runVerify({ get: vi.fn(), set: vi.fn() }, recoveryCode)).rejects.toMatchObject({
			status: 303
		});

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

		await expect(
			runVerify({ get: vi.fn(), set: vi.fn() }, recoveryCode.toLowerCase())
		).rejects.toMatchObject({
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

		const result = await runVerify({ get: vi.fn(), set: vi.fn() }, '123456');

		expect(result.status).toBe(400);
		expect(rateLimit.recordMfaAttempt).toHaveBeenCalledWith('challenge-1', expect.any(String));
	});

	it('redirige vers /login sans challenge valide', async () => {
		expect.assertions(1);

		mfaChallenge.readMfaChallenge.mockResolvedValue(null);

		await expect(runVerify({ get: vi.fn(), set: vi.fn() }, '123456')).rejects.toMatchObject({
			status: 303,
			location: '/login'
		});
	});
});

async function runVerify(
	cookies: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> },
	code: string
) {
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

/**
 * One security event per outcome of the code step (L3 contract). Expected pseudonyms come from the
 * production functions, the subnet width from the ruling (32 for the IPv4 client `runVerify`
 * uses). An account gone or a factor turned off before the code is read checks no secret, so it
 * writes nothing; a challenge ended after the code was accepted is `superseded` (#923). The limiter
 * only says which counter tripped; the route writes the refusal's line, naming the challenge's user.
 */
describe('/login/verify-totp action: security events (L3)', () => {
	const IP = '127.0.0.1';
	const RECOVERY_CODE = 'ABCDE-12345';

	beforeEach(() => {
		vi.clearAllMocks();
		captured.events.length = 0;
		captured.order.length = 0;
		mfaChallenge.readMfaChallenge.mockResolvedValue({ id: 'challenge-1', userId: 'user-a' });
		db.prisma.recoveryCode.findMany.mockResolvedValue([]);
	});

	function secondFactorFailure(reason: string) {
		return {
			event: EVENT.authnLoginFail,
			attributes: {
				[ATTRIBUTE.authnStep]: 'second_factor',
				[ATTRIBUTE.authnReason]: reason,
				[ATTRIBUTE.userPseudonym]: pseudonym.logUserPseudonym('user-a'),
				[ATTRIBUTE.clientPseudonym]: pseudonym.logPseudonym(IP),
				[ATTRIBUTE.clientSubnetPseudonym]: pseudonym.logSubnetPseudonym(IP),
				[ATTRIBUTE.clientSubnetPrefixLength]: 32
			}
		};
	}

	function success(factor: string) {
		return {
			event: EVENT.authnLoginSuccess,
			attributes: {
				[ATTRIBUTE.userPseudonym]: pseudonym.logUserPseudonym('user-a'),
				[ATTRIBUTE.authnFactor]: factor,
				[ATTRIBUTE.clientPseudonym]: pseudonym.logPseudonym(IP)
			}
		};
	}

	/** An account with 2FA on, and a code its authenticator shows now. */
	function enrolledAccount(): string {
		const secret = generateTotpSecretBase32();
		db.prisma.user.findUnique.mockResolvedValue({
			id: 'user-a',
			totpEnabled: true,
			totpSecretEncrypted: encryptTotpSecret(secret)
		});
		return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
	}

	async function acceptedRecoveryCode() {
		enrolledAccount();
		db.prisma.recoveryCode.findMany.mockResolvedValue([
			{ id: 'code-1', codeHash: await hashRecoveryCode(RECOVERY_CODE) }
		]);
		db.prisma.recoveryCode.updateMany.mockResolvedValue({ count: 1 });
		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });
	}

	/** What the action returned, or the redirect it threw as `{ status, location }`. */
	async function verify(code: string): Promise<unknown> {
		return runVerify({ get: vi.fn(), set: vi.fn() }, code).then(
			(returned) => ({ status: returned.status }),
			(thrown: { status?: number; location?: string }) => ({
				status: thrown.status,
				location: thrown.location
			})
		);
	}

	function attributesOfEach(): Record<string, unknown>[] {
		return captured.events.map((e) => (e as { attributes: Record<string, unknown> }).attributes);
	}

	it('a wrong TOTP code logs one second-factor failure with reason wrong_code', async () => {
		enrolledAccount();
		const answer = await verify('000000');
		expect({ answer, events: captured.events }).toEqual({
			answer: { status: 400 },
			events: [secondFactorFailure('wrong_code')]
		});
	});

	it('a TOTP code already used logs one second-factor failure with reason reused_code', async () => {
		const code = enrolledAccount();
		userClaims({ totpStepMatches: false });
		const answer = await verify(code);
		expect({ answer, events: captured.events }).toEqual({
			answer: { status: 400 },
			events: [secondFactorFailure('reused_code')]
		});
	});

	it('a wrong recovery code logs one second-factor failure with reason wrong_recovery_code', async () => {
		enrolledAccount();
		const answer = await verify(RECOVERY_CODE);
		expect({ answer, events: captured.events }).toEqual({
			answer: { status: 400 },
			events: [secondFactorFailure('wrong_recovery_code')]
		});
	});

	it.each([
		['the account was deleted meanwhile', () => db.prisma.user.findUnique.mockResolvedValue(null)],
		[
			'2FA was turned off in another tab',
			() =>
				db.prisma.user.findUnique.mockResolvedValue({
					id: 'user-a',
					totpEnabled: false,
					totpSecretEncrypted: null
				})
		]
	])('when %s, logs nothing: no secret was checked', async (_label, arrange) => {
		arrange();
		const answer = await verify('123456');
		expect({ answer, events: captured.events }).toEqual({
			answer: { status: 303, location: '/login' },
			events: []
		});
	});

	// #923: the challenge was ended (password change, « log out other sessions ») after it was read.
	it('a challenge superseded before the session is written logs one failure with reason superseded', async () => {
		const code = enrolledAccount();
		userClaims({ totpStepMatches: true });
		mfaChallenge.claimMfaChallenge.mockRejectedValueOnce(new SignInSuperseded());
		const answer = await verify(code);
		expect({ answer, events: captured.events }).toEqual({
			answer: { status: 303, location: '/login' },
			events: [secondFactorFailure('superseded')]
		});
	});

	it('a success by TOTP code logs one login success with the factor totp', async () => {
		const code = enrolledAccount();
		userClaims({ totpStepMatches: true });
		const answer = (await verify(code)) as { status: number };
		expect({ status: answer.status, events: captured.events }).toEqual({
			status: 303,
			events: [success('totp')]
		});
	});

	it('a success by recovery code logs one login success with the factor recovery_code', async () => {
		await acceptedRecoveryCode();
		const answer = (await verify(RECOVERY_CODE)) as { status: number };
		expect({ status: answer.status, events: captured.events }).toEqual({
			status: 303,
			events: [success('recovery_code')]
		});
	});

	// Invariant 1 at run time. The first element of each row calibrates the reading.
	it('neither login success carries a subnet label or a width', async () => {
		const code = enrolledAccount();
		userClaims({ totpStepMatches: true });
		await verify(code);
		await acceptedRecoveryCode();
		await verify(RECOVERY_CODE);
		expect(
			attributesOfEach().map((attributes) => [
				Object.hasOwn(attributes, ATTRIBUTE.clientPseudonym),
				Object.hasOwn(attributes, ATTRIBUTE.clientSubnetPseudonym),
				Object.hasOwn(attributes, ATTRIBUTE.clientSubnetPrefixLength)
			])
		).toEqual([
			[true, false, false],
			[true, false, false]
		]);
	});

	it.each([
		['an empty code', ''],
		['a code of spaces', '   ']
	])('%s logs nothing: no code was checked', async (_label, code) => {
		enrolledAccount();
		const answer = await verify(code);
		expect({ answer, events: captured.events }).toEqual({ answer: { status: 400 }, events: [] });
	});

	it('a request with no challenge cookie logs nothing', async () => {
		mfaChallenge.readMfaChallenge.mockResolvedValue(null);
		const answer = await verify('123456');
		expect({ answer, events: captured.events }).toEqual({
			answer: { status: 303, location: '/login' },
			events: []
		});
	});

	// Neither the TOTP shape nor the recovery-code shape: a secret attempt the limiter counts.
	it('a code matching neither shape logs one second-factor failure with reason unrecognised_code', async () => {
		enrolledAccount();
		const answer = await verify('not-a-code');
		expect({ answer, events: captured.events }).toEqual({
			answer: { status: 400 },
			events: [secondFactorFailure('unrecognised_code')]
		});
	});

	// The limiter decides and the route logs (design note point 2), with the user the challenge
	// names. Each counter in turn, so a counter written as a constant fails two of the three rows.
	it.each(['address', 'subject', 'both'] as const)(
		'a limiter refusal by the %s counter logs one rate-limit event naming that counter and the user',
		async (counter) => {
			rateLimit.isMfaRateLimited.mockResolvedValueOnce({ counter } as never);
			const result = await runVerify({ get: vi.fn(), set: vi.fn() }, '123456');
			expect({
				answer: { status: result.status, data: result.data },
				events: captured.events
			}).toEqual({
				answer: { status: 400, data: { error: m.mfa_verify_error_too_many_attempts() } },
				events: [
					{
						event: EVENT.rateLimitExceeded,
						attributes: {
							[ATTRIBUTE.rateLimitKind]: 'MFA',
							[ATTRIBUTE.rateLimitCounter]: counter,
							[ATTRIBUTE.userPseudonym]: pseudonym.logUserPseudonym('user-a'),
							[ATTRIBUTE.clientPseudonym]: pseudonym.logPseudonym(IP),
							[ATTRIBUTE.clientSubnetPseudonym]: pseudonym.logSubnetPseudonym(IP),
							[ATTRIBUTE.clientSubnetPrefixLength]: 32
						}
					}
				]
			});
		}
	);

	// Invariant 5 (#869): the pseudonym, and so the line, comes after the limiter record.
	it('a wrong code is logged after the attempt is recorded', async () => {
		enrolledAccount();
		await verify('000000');
		expect(captured.order).toEqual(['record', 'log']);
	});
});
