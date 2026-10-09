import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTRIBUTE, EVENT } from '$lib/server/logging/names';

vi.hoisted(() => {
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
		},
		// `createSession` writes inside a transaction (#923); the fake runs it against itself.
		$transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(prisma))
	};
	return { prisma };
});

/**
 * `user.updateMany` answers two claims on the password step: the seeding's (`count: 0`, already
 * seeded) and the compare-and-set that the verified hash is still the password (#923, `count: 1`).
 */
function answerUserUpdateMany(args: { data: Record<string, unknown> }) {
	return { count: 'passwordHash' in args.data ? 1 : 0 };
}

const rateLimit = vi.hoisted(() => ({
	isLoginRateLimited: vi.fn(async () => false),
	recordFailedLoginAttempt: vi.fn(async () => {
		captured.order.push('record');
	})
}));

const mfaChallenge = vi.hoisted(() => ({
	createMfaChallenge: vi.fn(async () => undefined)
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));
// The rest of the module stays real: the log pseudonyms read the limiter's secret and prefix.
vi.mock('$lib/server/auth/rateLimit', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/auth/rateLimit')>()),
	...rateLimit
}));
vi.mock('$lib/server/auth/mfaChallenge', () => mfaChallenge);

const { hashPassword } = await import('$lib/server/auth');
const { actions, load } = await import('./+page.server');
const pseudonym = await import('$lib/server/logging/pseudonym');

describe('/login action', () => {
	it('connecte avec un mot de passe valide sans retourner passwordHash', async () => {
		expect.assertions(5);

		const passwordHash = await hashPassword('mot-de-passe-long');
		db.prisma.user.findUnique.mockResolvedValue({ id: 'user-a', passwordHash });
		db.prisma.session.create.mockResolvedValue({ id: 'session-a' });
		// ensureDefaultCategoriesSeeded calls user.updateMany; count:0 = already seeded, no-op.
		db.prisma.user.updateMany.mockImplementation(async (args) => answerUserUpdateMany(args));
		const cookies = { get: vi.fn(), set: vi.fn() };

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
			{ get: vi.fn(), set: vi.fn() },
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
			{ get: vi.fn(), set: vi.fn() },
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
			{ get: vi.fn(), set: vi.fn() },
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
			{ get: vi.fn(), set: vi.fn() },
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
		const cookies = { get: vi.fn(), set: vi.fn() };

		await expect(
			runLogin(cookies, {
				email: 'a@example.test',
				password: 'mot-de-passe-long'
			})
		).rejects.toMatchObject({
			status: 303,
			location: expect.stringContaining('/login/verify-totp')
		});

		expect(mfaChallenge.createMfaChallenge).toHaveBeenCalledWith(
			'user-a',
			{ passwordHash, totpEnabled: true },
			cookies
		);
		expect(db.prisma.session.create).not.toHaveBeenCalled();
		expect(cookies.set).not.toHaveBeenCalled();
	});
});

async function runLogin(
	cookies: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> },
	input: Record<string, string>,
	ip = '127.0.0.1'
) {
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
		getClientAddress: () => ip,
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

	// The inactivity reason (#221) is read from the session cookie, never from the query string:
	// a link naming it, in any spelling, puts nothing on the page. That the cookie of a session
	// ended by inactivity does produce it is `e2e/session-idle.spec.ts`, against the build.
	it.each(['signed_out_idle', 'signedOutIdle', 'idle'])(
		'a query string cannot claim the inactivity reason: %s',
		async (value) => {
			expect.assertions(1);
			const result = await runLoad(`http://localhost/login?notice=${value}&${value}=true`);
			expect(result.signedOutIdle).toBe(false);
		}
	);
});

type LoadResult = { notice: string | null; signedOutIdle: boolean };

/** The load for a browser holding no session cookie. */
async function runLoad(url: string): Promise<LoadResult> {
	return (await (
		load as unknown as (event: {
			cookies: { get: () => undefined };
			locals: { user: null };
			url: URL;
		}) => Promise<LoadResult>
	)({
		cookies: { get: () => undefined },
		locals: { user: null },
		url: new URL(url)
	})) as LoadResult;
}

/**
 * One security event per outcome of the password step (L3 contract). Expected pseudonyms come
 * from the production functions; the subnet width from the ruling (32 for IPv4, the configured
 * prefix for IPv6), never from `logSubnet`, which the implementation calls. The limiter only says
 * which counter tripped (`auth/rateLimit.spec.ts`); the route writes the refusal's line.
 */
describe('/login action: security events (L3)', () => {
	const IP = '127.0.0.1';
	const V6 = '2001:db8:aa:bb00::1';
	const PASSWORD = 'mot-de-passe-long';
	/** The answer every refused credential got before L3, from the tests above. */
	const REFUSED = { status: 400, data: { error: 'Identifiants invalides' } };

	let passwordHash: string;

	beforeEach(async () => {
		vi.clearAllMocks();
		captured.events.length = 0;
		captured.order.length = 0;
		passwordHash ??= await hashPassword(PASSWORD);
		db.prisma.session.create.mockResolvedValue({ id: 'session-a' });
		db.prisma.user.updateMany.mockImplementation(async (args) => answerUserUpdateMany(args));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	function passwordStepFailure(reason: string, userId?: string, ip = IP, width = 32) {
		return {
			event: EVENT.authnLoginFail,
			attributes: {
				[ATTRIBUTE.authnStep]: 'password',
				[ATTRIBUTE.authnReason]: reason,
				...(userId === undefined
					? {}
					: { [ATTRIBUTE.userPseudonym]: pseudonym.logUserPseudonym(userId) }),
				[ATTRIBUTE.clientPseudonym]: pseudonym.logPseudonym(ip),
				[ATTRIBUTE.clientSubnetPseudonym]: pseudonym.logSubnetPseudonym(ip),
				[ATTRIBUTE.clientSubnetPrefixLength]: width
			}
		};
	}

	/** The one line written, or a throw naming how many were. */
	function onlyAttributes(): Record<string, unknown> {
		if (captured.events.length !== 1) {
			throw new Error(`expected one event, the action wrote ${captured.events.length}`);
		}
		return (captured.events[0] as { attributes: Record<string, unknown> }).attributes;
	}

	/** The redirect status a successful step throws, or what it returned instead. */
	async function outcome(run: Promise<unknown>): Promise<unknown> {
		return run.then(
			(returned) => returned,
			(thrown: { status?: number }) => thrown.status
		);
	}

	function signIn(password: string, ip = IP) {
		return runLogin({ get: vi.fn(), set: vi.fn() }, { email: 'a@example.test', password }, ip);
	}

	it('an unknown account logs one password-step failure with the address and its subnet', async () => {
		db.prisma.user.findUnique.mockResolvedValue(null);
		await signIn('peu-importe-le-mot-de-passe');
		expect(captured.events).toEqual([passwordStepFailure('unknown_account')]);
	});

	// The first element calibrates the reading: a key the line carries does read as present.
	it('an unknown-account failure carries no user field', async () => {
		db.prisma.user.findUnique.mockResolvedValue(null);
		await signIn('peu-importe-le-mot-de-passe');
		const attributes = onlyAttributes();
		expect([
			Object.hasOwn(attributes, ATTRIBUTE.clientPseudonym),
			Object.hasOwn(attributes, ATTRIBUTE.userPseudonym)
		]).toEqual([true, false]);
	});

	it('a wrong password logs one password-step failure naming the user by pseudonym', async () => {
		db.prisma.user.findUnique.mockResolvedValue({ id: 'user-a', passwordHash });
		await signIn('mauvais-mot-de-passe');
		expect(captured.events).toEqual([passwordStepFailure('wrong_password', 'user-a')]);
	});

	// 48 is not the default, so a width written as 56 or 32 fails here.
	it('an IPv6 wrong password carries the configured width and the label at that width', async () => {
		vi.stubEnv('BP_RATE_LIMIT_IPV6_PREFIX', '48');
		db.prisma.user.findUnique.mockResolvedValue({ id: 'user-a', passwordHash });
		await signIn('mauvais-mot-de-passe', V6);
		expect(captured.events).toEqual([passwordStepFailure('wrong_password', 'user-a', V6, 48)]);
	});

	// #923: the password changed while bcrypt ran, so the compare-and-set claims no row.
	it('a sign-in superseded by a password change logs one failure with reason superseded', async () => {
		db.prisma.user.findUnique.mockResolvedValue({ id: 'user-a', passwordHash });
		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });
		const result = await signIn(PASSWORD);
		expect({ status: result.status, events: captured.events }).toEqual({
			status: 400,
			events: [passwordStepFailure('superseded', 'user-a')]
		});
	});

	it('a success without a second factor logs one login success with the factor password', async () => {
		db.prisma.user.findUnique.mockResolvedValue({ id: 'user-a', passwordHash, totpEnabled: false });
		const status = await outcome(signIn(PASSWORD));
		expect({ status, events: captured.events }).toEqual({
			status: 303,
			events: [
				{
					event: EVENT.authnLoginSuccess,
					attributes: {
						[ATTRIBUTE.userPseudonym]: pseudonym.logUserPseudonym('user-a'),
						[ATTRIBUTE.authnFactor]: 'password',
						[ATTRIBUTE.clientPseudonym]: pseudonym.logPseudonym(IP)
					}
				}
			]
		});
	});

	// Invariant 1 at run time. The first element calibrates the reading.
	it('a login success carries no subnet label and no width', async () => {
		db.prisma.user.findUnique.mockResolvedValue({ id: 'user-a', passwordHash, totpEnabled: false });
		await outcome(signIn(PASSWORD));
		const attributes = onlyAttributes();
		expect([
			Object.hasOwn(attributes, ATTRIBUTE.clientPseudonym),
			Object.hasOwn(attributes, ATTRIBUTE.clientSubnetPseudonym),
			Object.hasOwn(attributes, ATTRIBUTE.clientSubnetPrefixLength)
		]).toEqual([true, false, false]);
	});

	it('a password accepted on an account with 2FA logs one second-factor-required event', async () => {
		db.prisma.user.findUnique.mockResolvedValue({ id: 'user-a', passwordHash, totpEnabled: true });
		const status = await outcome(signIn(PASSWORD));
		expect({ status, events: captured.events }).toEqual({
			status: 303,
			events: [
				{
					event: EVENT.authnSecondFactorRequired,
					attributes: {
						[ATTRIBUTE.userPseudonym]: pseudonym.logUserPseudonym('user-a'),
						[ATTRIBUTE.clientPseudonym]: pseudonym.logPseudonym(IP)
					}
				}
			]
		});
	});

	it('a second-factor-required event carries no subnet label and no width', async () => {
		db.prisma.user.findUnique.mockResolvedValue({ id: 'user-a', passwordHash, totpEnabled: true });
		await outcome(signIn(PASSWORD));
		const attributes = onlyAttributes();
		expect([
			Object.hasOwn(attributes, ATTRIBUTE.clientPseudonym),
			Object.hasOwn(attributes, ATTRIBUTE.clientSubnetPseudonym),
			Object.hasOwn(attributes, ATTRIBUTE.clientSubnetPrefixLength)
		]).toEqual([true, false, false]);
	});

	it('a malformed form, with an empty password, logs nothing: no credential was checked', async () => {
		const result = await signIn('');
		expect({ status: result.status, events: captured.events }).toEqual({ status: 400, events: [] });
	});

	// The limiter decides and the route logs (design note point 2). Each counter in turn, so a
	// counter written as a constant fails two of the three rows. No user: the account is not looked up.
	it.each(['address', 'subject', 'both'] as const)(
		'a limiter refusal by the %s counter logs one rate-limit event naming that counter, and answers as before',
		async (counter) => {
			rateLimit.isLoginRateLimited.mockResolvedValueOnce({ counter } as never);
			const result = await signIn(PASSWORD);
			expect({
				answer: { status: result.status, data: result.data },
				events: captured.events
			}).toEqual({
				answer: {
					status: 400,
					data: { error: 'Trop de tentatives. Réessayez dans quelques minutes.' }
				},
				events: [
					{
						event: EVENT.rateLimitExceeded,
						attributes: {
							[ATTRIBUTE.rateLimitKind]: 'LOGIN',
							[ATTRIBUTE.rateLimitCounter]: counter,
							[ATTRIBUTE.clientPseudonym]: pseudonym.logPseudonym(IP),
							[ATTRIBUTE.clientSubnetPseudonym]: pseudonym.logSubnetPseudonym(IP),
							[ATTRIBUTE.clientSubnetPrefixLength]: 32
						}
					}
				]
			});
		}
	);

	it('a limiter refusal names no user', async () => {
		rateLimit.isLoginRateLimited.mockResolvedValueOnce({ counter: 'subject' } as never);
		await signIn(PASSWORD);
		const attributes = onlyAttributes();
		expect([
			Object.hasOwn(attributes, ATTRIBUTE.clientPseudonym),
			Object.hasOwn(attributes, ATTRIBUTE.userPseudonym)
		]).toEqual([true, false]);
	});

	// Invariant 4: the wrong password and the unknown account answer alike, and as they did before.
	it('logging leaves the answer unchanged: a wrong password and an unknown account answer alike', async () => {
		db.prisma.user.findUnique.mockResolvedValueOnce({ id: 'user-a', passwordHash });
		const wrong = await signIn('mauvais-mot-de-passe');
		db.prisma.user.findUnique.mockResolvedValueOnce(null);
		const unknown = await signIn('mauvais-mot-de-passe');
		expect([
			{ status: wrong.status, data: wrong.data },
			{ status: unknown.status, data: unknown.data }
		]).toEqual([REFUSED, REFUSED]);
	});

	// Design note point 5: the pseudonym throws on a value that is not an address, so it must be
	// taken after the record. Whether the action then throws is the helper's; the record is not.
	it('a failure from a client whose address cannot be read is still recorded', async () => {
		db.prisma.user.findUnique.mockResolvedValue({ id: 'user-a', passwordHash });
		// Not `undefined`, which the helper's default would replace with an address.
		await outcome(signIn('mauvais-mot-de-passe', 'not-an-address'));
		expect(rateLimit.recordFailedLoginAttempt.mock.calls).toEqual([
			['a@example.test', 'not-an-address']
		]);
	});

	// Invariant 5 (#869): the pseudonym, and so the line, comes after the limiter record.
	it.each([
		['a wrong password', () => ({ id: 'user-a', passwordHash })],
		['an unknown account', () => null]
	])('%s is logged after the attempt is recorded', async (_label, account) => {
		db.prisma.user.findUnique.mockResolvedValue(account());
		await signIn('mauvais-mot-de-passe');
		expect(captured.order).toEqual(['record', 'log']);
	});
});
