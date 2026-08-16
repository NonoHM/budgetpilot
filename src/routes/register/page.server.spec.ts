import { afterEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	prisma: {
		user: {
			count: vi.fn(),
			findUnique: vi.fn(),
			create: vi.fn(),
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
		invitation: {
			updateMany: vi.fn()
		},
		$transaction: vi.fn(async (callback) => callback(db.prisma))
	}
}));
const privateEnv = vi.hoisted(() => ({
	env: {
		BOOTSTRAP_TOKEN: 'bootstrap-secret' as string | undefined,
		RATE_LIMIT_HASH_SECRET: 'test-only-rate-limit-hash-secret' as string | undefined,
		REGISTRATION_MODE: undefined as string | undefined
	}
}));
const rateLimit = vi.hoisted(() => ({
	isRegisterRateLimited: vi.fn(async () => false),
	recordRegisterAttempt: vi.fn(async () => undefined),
	isInviteRateLimited: vi.fn(async () => false),
	recordInviteAttempt: vi.fn(async () => undefined)
}));
const invitations = vi.hoisted(() => ({
	findValidInvitationByToken: vi.fn(async () => null as { id: string; email: string | null } | null)
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));
vi.mock('$env/dynamic/private', () => privateEnv);
vi.mock('$lib/server/auth/rateLimit', () => rateLimit);
vi.mock('$lib/server/auth/invitations', () => invitations);

const { actions, load } = await import('./+page.server');

describe('/register action', () => {
	afterEach(() => {
		privateEnv.env.BOOTSTRAP_TOKEN = 'bootstrap-secret';
		privateEnv.env.REGISTRATION_MODE = undefined;
		vi.clearAllMocks();
	});

	it('creates the first admin user with a bcrypt passwordHash without exposing the hash', async () => {
		expect.assertions(6);

		db.prisma.user.count.mockResolvedValue(0);
		db.prisma.user.findUnique.mockResolvedValue(null);
		db.prisma.user.create.mockResolvedValue({ id: 'user-a' });
		db.prisma.session.create.mockResolvedValue({ id: 'session-a' });
		// ensureDefaultCategoriesSeeded calls user.updateMany; count:0 = already seeded, no-op.
		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });
		const cookies = { set: vi.fn() };

		await expect(
			runRegister(cookies, {
				email: 'A@Example.TEST',
				password: 'mot-de-passe-long',
				bootstrapToken: 'bootstrap-secret'
			})
		).rejects.toMatchObject({ status: 303 });

		const createData = db.prisma.user.create.mock.calls[0][0].data;
		expect(createData.email).toBe('a@example.test');
		expect(createData.role).toBe('ADMIN');
		expect(createData.passwordHash).toMatch(/^\$2[aby]\$/);
		expect(createData.passwordHash).not.toBe('mot-de-passe-long');
		expect(JSON.stringify(db.prisma.session.create.mock.calls[0][0])).not.toContain(
			createData.passwordHash
		);
	});

	it('refuse le premier utilisateur sans jeton bootstrap', async () => {
		expect.assertions(3);

		privateEnv.env.BOOTSTRAP_TOKEN = undefined;
		db.prisma.user.count.mockResolvedValue(0);
		db.prisma.user.findUnique.mockResolvedValue(null);

		const result = await runRegister(
			{ set: vi.fn() },
			{
				email: 'a@example.test',
				password: 'mot-de-passe-long'
			}
		);

		expect(result.status).toBe(403);
		expect(result.data.error).toBe(
			'Jeton bootstrap invalide. Vérifiez la valeur de BOOTSTRAP_TOKEN dans votre fichier .env, en copiant la ligne entière après le signe égal.'
		);
		expect(db.prisma.user.create).not.toHaveBeenCalled();
	});

	it('accepte le jeton bootstrap correct', async () => {
		expect.assertions(1);

		db.prisma.user.count.mockResolvedValue(0);
		db.prisma.user.findUnique.mockResolvedValue(null);
		db.prisma.user.create.mockResolvedValue({ id: 'user-a' });
		db.prisma.session.create.mockResolvedValue({ id: 'session-a' });
		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			runRegister(
				{ set: vi.fn() },
				{
					email: 'a@example.test',
					password: 'mot-de-passe-long',
					bootstrapToken: 'bootstrap-secret'
				}
			)
		).rejects.toMatchObject({ status: 303 });
	});

	it('rejects an incorrect bootstrap token of the same length as the expected token', async () => {
		expect.assertions(3);

		db.prisma.user.count.mockResolvedValue(0);
		db.prisma.user.findUnique.mockResolvedValue(null);

		const result = await runRegister(
			{ set: vi.fn() },
			{
				email: 'a@example.test',
				password: 'mot-de-passe-long',
				// same length as 'bootstrap-secret' (16 characters)
				bootstrapToken: 'wrongtoken123456'
			}
		);

		expect(result.status).toBe(403);
		expect(result.data.error).toBe(
			'Jeton bootstrap invalide. Vérifiez la valeur de BOOTSTRAP_TOKEN dans votre fichier .env, en copiant la ligne entière après le signe égal.'
		);
		expect(db.prisma.user.create).not.toHaveBeenCalled();
	});

	it('rejects a bootstrap token of a different length without crashing', async () => {
		expect.assertions(3);

		db.prisma.user.count.mockResolvedValue(0);
		db.prisma.user.findUnique.mockResolvedValue(null);

		const result = await runRegister(
			{ set: vi.fn() },
			{
				email: 'a@example.test',
				password: 'mot-de-passe-long',
				bootstrapToken: 'trop-court'
			}
		);

		expect(result.status).toBe(403);
		expect(result.data.error).toBe(
			'Jeton bootstrap invalide. Vérifiez la valeur de BOOTSTRAP_TOKEN dans votre fichier .env, en copiant la ligne entière après le signe égal.'
		);
		expect(db.prisma.user.create).not.toHaveBeenCalled();
	});

	it('tells a wrong token apart from a closed instance, in one assertion so the two cannot recollapse', async () => {
		expect.assertions(4);

		// The two conditions used to share `register_error_unavailable`, which is false for the
		// first one: registration IS available there, only the token is wrong. Asserting each
		// message separately would not have caught that — both were "correct" in isolation. What
		// makes the distinction load-bearing is comparing them in the SAME test, so re-pointing
		// either branch at the other's message fails here.

		// Registration open (first user, count 0), token wrong.
		db.prisma.user.count.mockResolvedValue(0);
		db.prisma.user.findUnique.mockResolvedValue(null);
		const badToken = await runRegister(
			{ set: vi.fn() },
			{
				email: 'a@example.test',
				password: 'mot-de-passe-long',
				bootstrapToken: 'wrongtoken123456'
			}
		);

		// Registration genuinely closed: admin_only with an account already present, so the request
		// never reaches the token check at all.
		db.prisma.user.count.mockResolvedValue(1);
		db.prisma.user.findUnique.mockResolvedValue(null);
		const closed = await runRegister(
			{ set: vi.fn() },
			{ email: 'a@example.test', password: 'mot-de-passe-long' }
		);

		// Same status on purpose — 403 either way is correct, and is exactly why the status cannot
		// carry the difference and the message has to.
		expect(badToken.status).toBe(403);
		expect(closed.status).toBe(403);
		expect(badToken.data.error).not.toBe(closed.data.error);
		expect(closed.data.error).toBe('Inscription indisponible.');
	});

	it('claim le backfill uniquement si le compte technique est encore intact', async () => {
		expect.assertions(5);

		db.prisma.user.count.mockResolvedValue(1);
		db.prisma.user.findUnique.mockResolvedValue({ email: 'local-backfill@budgetpilot.local' });
		// First call: claimBackfillUser (count:1). Second call: ensureDefaultCategoriesSeeded (count:0 = already seeded).
		db.prisma.user.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
		db.prisma.session.create.mockResolvedValue({ id: 'session-a' });

		await expect(
			runRegister(
				{ set: vi.fn() },
				{
					email: 'owner@example.test',
					password: 'mot-de-passe-long',
					bootstrapToken: 'bootstrap-secret'
				}
			)
		).rejects.toMatchObject({ status: 303 });

		expect(db.prisma.user.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: 'local-backfill-user',
					email: 'local-backfill@budgetpilot.local',
					passwordHash: 'BACKFILL_LOGIN_DISABLED'
				}
			})
		);
		expect(db.prisma.user.updateMany.mock.calls[0][0].data.email).toBe('owner@example.test');
		expect(db.prisma.user.create).not.toHaveBeenCalled();
		expect(db.prisma.session.create.mock.calls[0][0].data.userId).toBe('local-backfill-user');
	});

	it('admin_only mode (variable absent): an anonymous attempt IS rate limited', async () => {
		expect.assertions(4);

		// This test used to assert the OPPOSITE — that admin_only triggers no register rate
		// limiting at all. That was reasonable when it was written, under a condition that has
		// since stopped holding: admin_only meant "closed instance, nobody can register anyway",
		// so counting attempts would only have been noise.
		//
		// It stopped being reasonable once the same mode became the path where BOOTSTRAP_TOKEN is
		// the only gate on creating the FIRST account, and that first account is ADMIN. The old
		// assertion then stood guard over a real gap rather than over a deliberate absence:
		// measured on a running instance, 250 wrong tokens from one IP met no throttling at any
		// point, while /login tripped its limiter immediately, and the 251st attempt with the
		// correct token created the account.
		//
		// The condition this assertion now depends on: anonymous requests in admin_only mode can
		// reach a secret check (the bootstrap token). If registration ever stops being reachable
		// anonymously in this mode, revisit — but do not "restore" the old assertion without
		// establishing that first.
		db.prisma.user.count.mockResolvedValue(1);
		db.prisma.user.findUnique.mockResolvedValue(null);

		const result = await runRegister(
			{ set: vi.fn() },
			{ email: 'a@example.test', password: 'mot-de-passe-long' }
		);

		expect(result.status).toBe(403);
		expect(result.data.error).toBe('Inscription indisponible.');
		expect(rateLimit.isRegisterRateLimited).toHaveBeenCalledWith('127.0.0.1');
		expect(rateLimit.recordRegisterAttempt).toHaveBeenCalledWith('127.0.0.1');
	});

	it("mode admin_only avec une valeur REGISTRATION_MODE inconnue (typo 'OPEN') : reste en fail-safe admin_only", async () => {
		expect.assertions(3);

		privateEnv.env.REGISTRATION_MODE = 'OPEN';
		db.prisma.user.count.mockResolvedValue(1);
		db.prisma.user.findUnique.mockResolvedValue(null);

		const result = await runRegister(
			{ set: vi.fn() },
			{ email: 'a@example.test', password: 'mot-de-passe-long' }
		);

		expect(result.status).toBe(403);
		expect(result.data.error).toBe('Inscription indisponible.');
		// Same flip, same reason as the test above: the fail-safe lands in admin_only, which is
		// the throttled path for an anonymous caller. A typo'd REGISTRATION_MODE must not be a
		// way to reach the token check without a counter.
		expect(rateLimit.isRegisterRateLimited).toHaveBeenCalledWith('127.0.0.1');
	});

	it('admin_only mode: a wrong bootstrap token counts as an attempt (guessing is bounded)', async () => {
		expect.assertions(3);

		db.prisma.user.count.mockResolvedValue(0);
		db.prisma.user.findUnique.mockResolvedValue(null);

		const result = await runRegister(
			{ set: vi.fn() },
			{
				email: 'a@example.test',
				password: 'mot-de-passe-long',
				bootstrapToken: 'wrongtoken123456'
			}
		);

		expect(result.status).toBe(403);
		expect(rateLimit.isRegisterRateLimited).toHaveBeenCalledWith('127.0.0.1');
		expect(rateLimit.recordRegisterAttempt).toHaveBeenCalledWith('127.0.0.1');
	});

	it('admin_only mode: past the limit, even the CORRECT bootstrap token is refused', async () => {
		expect.assertions(4);

		// The conclusive assertion, and the unit-test mirror of the live probe that found the gap.
		// "Wrong tokens return an error" proves nothing on its own — they returned an error before
		// this fix too, and an unthrottled 403 is exactly what 250 successful guesses look like.
		// What proves the limiter actually gates the token check is that a request which WOULD
		// have created the ADMIN account does not, because it never reaches the check at all.
		db.prisma.user.count.mockResolvedValue(0);
		db.prisma.user.findUnique.mockResolvedValue(null);
		db.prisma.user.create.mockResolvedValue({ id: 'user-should-not-exist' });
		rateLimit.isRegisterRateLimited.mockResolvedValueOnce(true);
		const cookies = { set: vi.fn() };

		const result = await runRegister(cookies, {
			email: 'a@example.test',
			password: 'mot-de-passe-long',
			bootstrapToken: 'bootstrap-secret'
		});

		expect(result.status).toBe(429);
		expect(result.data.error).toBe('Trop de tentatives. Réessayez plus tard.');
		expect(db.prisma.user.create).not.toHaveBeenCalled();
		expect(cookies.set).not.toHaveBeenCalled();
	});

	it('admin_only mode: a logged-in ADMIN creating accounts is NOT rate limited', async () => {
		expect.assertions(3);

		// The limiter is keyed by IP alone, and an admin legitimately adding a sixth user in one
		// sitting would otherwise lock themselves out of their own instance for 15 minutes. The
		// throttle exists to bound guessing of a secret; an authenticated admin is past that gate
		// already and supplies no token. Deliberate exemption, not an oversight.
		db.prisma.user.count.mockResolvedValue(2);
		db.prisma.user.findUnique.mockResolvedValue(null);
		db.prisma.user.create.mockResolvedValue({ id: 'user-by-admin' });
		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });

		const result = await runRegister(
			{ set: vi.fn() },
			{ email: 'nouveau@example.test', password: 'mot-de-passe-long' },
			{ user: { role: 'ADMIN' } }
		);

		expect(result.success).toBe('Utilisateur créé.');
		expect(rateLimit.isRegisterRateLimited).not.toHaveBeenCalled();
		expect(rateLimit.recordRegisterAttempt).not.toHaveBeenCalled();
	});

	it('open mode: successful registration even without bootstrapToken (the token is ignored)', async () => {
		expect.assertions(3);

		privateEnv.env.REGISTRATION_MODE = 'open';
		db.prisma.user.count.mockResolvedValue(3);
		db.prisma.user.findUnique.mockResolvedValue(null);
		db.prisma.user.create.mockResolvedValue({ id: 'user-b' });
		db.prisma.session.create.mockResolvedValue({ id: 'session-b' });
		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });
		const cookies = { set: vi.fn() };

		await expect(
			runRegister(cookies, {
				email: 'nouveau@example.test',
				password: 'mot-de-passe-long'
			})
		).rejects.toMatchObject({ status: 303 });

		const createData = db.prisma.user.create.mock.calls[0][0].data;
		expect(createData.email).toBe('nouveau@example.test');
		expect(createData.role).toBe('USER');
	});

	it('open mode: rate limited after too many attempts from the same IP (429)', async () => {
		expect.assertions(3);

		privateEnv.env.REGISTRATION_MODE = 'open';
		rateLimit.isRegisterRateLimited.mockResolvedValueOnce(true);

		const result = await runRegister(
			{ set: vi.fn() },
			{ email: 'a@example.test', password: 'mot-de-passe-long' }
		);

		expect(result.status).toBe(429);
		expect(result.data.error).toBe('Trop de tentatives. Réessayez plus tard.');
		expect(db.prisma.user.create).not.toHaveBeenCalled();
	});

	it('open mode: counts validation failures as attempts (not just successes)', async () => {
		expect.assertions(2);

		privateEnv.env.REGISTRATION_MODE = 'open';
		db.prisma.user.count.mockResolvedValue(3);
		db.prisma.user.findUnique.mockResolvedValue(null);

		const result = await runRegister(
			{ set: vi.fn() },
			{ email: 'pas-un-email', password: 'mot-de-passe-long' }
		);

		expect(result.status).toBe(400);
		expect(rateLimit.recordRegisterAttempt).toHaveBeenCalledWith('127.0.0.1');
	});

	it('open mode: also counts successful registrations as an attempt (unlike login)', async () => {
		expect.assertions(1);

		privateEnv.env.REGISTRATION_MODE = 'open';
		db.prisma.user.count.mockResolvedValue(3);
		db.prisma.user.findUnique.mockResolvedValue(null);
		db.prisma.user.create.mockResolvedValue({ id: 'user-c' });
		db.prisma.session.create.mockResolvedValue({ id: 'session-c' });
		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });

		await runRegister(
			{ set: vi.fn() },
			{ email: 'succes@example.test', password: 'mot-de-passe-long' }
		).catch(() => undefined);

		expect(rateLimit.recordRegisterAttempt).toHaveBeenCalledWith('127.0.0.1');
	});
});

describe('/register action — invitation', () => {
	afterEach(() => {
		privateEnv.env.REGISTRATION_MODE = undefined;
		vi.clearAllMocks();
	});

	it('registration via a valid generic invitation in admin_only mode (no bootstrapToken required)', async () => {
		expect.assertions(3);

		invitations.findValidInvitationByToken.mockResolvedValue({ id: 'invite-a', email: null });
		db.prisma.user.count.mockResolvedValue(2);
		db.prisma.user.create.mockResolvedValue({ id: 'user-invited' });
		db.prisma.invitation.updateMany.mockResolvedValue({ count: 1 });
		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });
		db.prisma.session.create.mockResolvedValue({ id: 'session-invited' });

		await expect(
			runRegister(
				{ set: vi.fn() },
				{ email: 'invite@example.test', password: 'mot-de-passe-long' },
				{ user: null },
				'valid-invite-token'
			)
		).rejects.toMatchObject({ status: 303 });

		expect(db.prisma.user.create.mock.calls[0][0].data.role).toBe('USER');
		expect(db.prisma.invitation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ id: 'invite-a' }) })
		);
	});

	it('rejects an invalid/expired/revoked token (410), without creating an account', async () => {
		expect.assertions(3);

		invitations.findValidInvitationByToken.mockResolvedValue(null);

		const result = await runRegister(
			{ set: vi.fn() },
			{ email: 'invite@example.test', password: 'mot-de-passe-long' },
			{ user: null },
			'expired-token'
		);

		expect(result.status).toBe(410);
		expect(result.data.error).toBe('Cette invitation est invalide, expirée ou déjà utilisée.');
		expect(db.prisma.user.create).not.toHaveBeenCalled();
	});

	it('named invitation: rejects an email different from the targeted one', async () => {
		expect.assertions(2);

		invitations.findValidInvitationByToken.mockResolvedValue({
			id: 'invite-b',
			email: 'cible@example.test'
		});

		const result = await runRegister(
			{ set: vi.fn() },
			{ email: 'autre@example.test', password: 'mot-de-passe-long' },
			{ user: null },
			'nominative-token'
		);

		expect(result.status).toBe(400);
		expect(db.prisma.user.create).not.toHaveBeenCalled();
	});

	it('if the atomic consumption fails (count !== 1), returns 410 and does not open a session', async () => {
		expect.assertions(3);

		invitations.findValidInvitationByToken.mockResolvedValue({ id: 'invite-c', email: null });
		db.prisma.user.count.mockResolvedValue(2);
		db.prisma.user.create.mockResolvedValue({ id: 'user-race-loser' });
		db.prisma.invitation.updateMany.mockResolvedValue({ count: 0 });
		const cookies = { set: vi.fn() };

		const result = await runRegister(
			cookies,
			{ email: 'perdant@example.test', password: 'mot-de-passe-long' },
			{ user: null },
			'race-token'
		);

		expect(result.status).toBe(410);
		expect(result.data.error).toBe('Cette invitation est invalide, expirée ou déjà utilisée.');
		expect(cookies.set).not.toHaveBeenCalled();
	});

	it(
		'two concurrent consumptions of the same invitation token: only one succeeds ' +
			'(the row count affected by the conditional updateMany arbitrates the race, not a prior read)',
		async () => {
			expect.assertions(4);

			invitations.findValidInvitationByToken.mockResolvedValue({ id: 'invite-race', email: null });
			db.prisma.user.count.mockResolvedValue(2);
			db.prisma.user.updateMany.mockResolvedValue({ count: 0 });
			let created = 0;
			db.prisma.user.create.mockImplementation(async () => {
				created += 1;
				return { id: `user-${created}` };
			});

			// Models the real atomic constraint of a conditional updateMany (usedAt: null): only one
			// of the two "concurrent requests" can match the still-unconsumed row. The critical
			// section below is synchronous (no await before reading+writing the flag), which
			// faithfully reproduces the serialization a real SQLite transaction would enforce on the same row.
			let invitationConsumed = false;
			db.prisma.invitation.updateMany.mockImplementation(async () => {
				if (invitationConsumed) return { count: 0 };
				invitationConsumed = true;
				return { count: 1 };
			});

			const cookiesA = { set: vi.fn() };
			const cookiesB = { set: vi.fn() };

			const [resultA, resultB] = await Promise.allSettled([
				runRegister(
					cookiesA,
					{ email: 'racer-a@example.test', password: 'mot-de-passe-long' },
					{ user: null },
					'shared-race-token'
				),
				runRegister(
					cookiesB,
					{ email: 'racer-b@example.test', password: 'mot-de-passe-long' },
					{ user: null },
					'shared-race-token'
				)
			]);

			const outcomes = [resultA, resultB].map((settled) => {
				if (settled.status === 'rejected') {
					const reason = settled.reason as { status?: number };
					return reason.status === 303 ? 'redirected' : 'other-error';
				}
				return settled.value.status === 410 ? 'invitation-invalid' : 'other-fail';
			});

			expect(outcomes.filter((outcome) => outcome === 'redirected')).toHaveLength(1);
			expect(outcomes.filter((outcome) => outcome === 'invitation-invalid')).toHaveLength(1);
			expect(db.prisma.invitation.updateMany).toHaveBeenCalledTimes(2);
			// Only one of the two sessions should have been opened (the loser of the race should not
			// have reached createSession, even though its user.create was called before the rollback).
			expect(cookiesA.set.mock.calls.length + cookiesB.set.mock.calls.length).toBe(1);
		}
	);

	it(
		'already-logged-in ADMIN uses an invitation link: creates the invited account without opening ' +
			'a session for them (the admin stays logged in under their own session)',
		async () => {
			expect.assertions(4);

			invitations.findValidInvitationByToken.mockResolvedValue({ id: 'invite-admin', email: null });
			db.prisma.user.count.mockResolvedValue(2);
			db.prisma.user.create.mockResolvedValue({ id: 'user-invited-by-admin' });
			db.prisma.invitation.updateMany.mockResolvedValue({ count: 1 });
			db.prisma.user.updateMany.mockResolvedValue({ count: 0 });
			const cookies = { set: vi.fn() };

			const result = await runRegister(
				cookies,
				{ email: 'nouveau-invite@example.test', password: 'mot-de-passe-long' },
				{ user: { role: 'ADMIN' } },
				'admin-uses-invite-token'
			);

			expect(result.success).toBe('Utilisateur créé.');
			expect(db.prisma.user.create.mock.calls[0][0].data.role).toBe('USER');
			expect(db.prisma.session.create).not.toHaveBeenCalled();
			expect(cookies.set).not.toHaveBeenCalled();
		}
	);

	it(
		'open mode + invitation token present: only INVITE rate limiting ' +
			'applies (the general REGISTER rate limiting is not triggered)',
		async () => {
			expect.assertions(3);

			privateEnv.env.REGISTRATION_MODE = 'open';
			invitations.findValidInvitationByToken.mockResolvedValue({ id: 'invite-open', email: null });
			db.prisma.user.count.mockResolvedValue(2);
			db.prisma.user.create.mockResolvedValue({ id: 'user-open-invite' });
			db.prisma.invitation.updateMany.mockResolvedValue({ count: 1 });
			db.prisma.user.updateMany.mockResolvedValue({ count: 0 });
			db.prisma.session.create.mockResolvedValue({ id: 'session-open-invite' });

			await expect(
				runRegister(
					{ set: vi.fn() },
					{ email: 'open-invite@example.test', password: 'mot-de-passe-long' },
					{ user: null },
					'open-mode-invite-token'
				)
			).rejects.toMatchObject({ status: 303 });

			expect(rateLimit.isInviteRateLimited).toHaveBeenCalledWith('127.0.0.1');
			expect(rateLimit.isRegisterRateLimited).not.toHaveBeenCalled();
		}
	);

	it(
		'unique email collision (P2002) during invitation-based creation: returns 400 ' +
			"sans consommer l'invitation (le updateMany conditionnel n'est jamais atteint)",
		async () => {
			expect.assertions(3);

			invitations.findValidInvitationByToken.mockResolvedValue({ id: 'invite-dup', email: null });
			db.prisma.user.count.mockResolvedValue(2);
			db.prisma.user.create.mockRejectedValue({ code: 'P2002' });
			const cookies = { set: vi.fn() };

			const result = await runRegister(
				cookies,
				{ email: 'deja-existant@example.test', password: 'mot-de-passe-long' },
				{ user: null },
				'dup-email-invite-token'
			);

			expect(result.status).toBe(400);
			expect(db.prisma.invitation.updateMany).not.toHaveBeenCalled();
			expect(cookies.set).not.toHaveBeenCalled();
		}
	);

	it(
		'named invitation: the email comparison is case-insensitive ' +
			'(no false rejection for a different case)',
		async () => {
			expect.assertions(1);

			invitations.findValidInvitationByToken.mockResolvedValue({
				id: 'invite-case',
				email: 'cible@example.test'
			});
			db.prisma.user.count.mockResolvedValue(2);
			db.prisma.user.create.mockResolvedValue({ id: 'user-case-match' });
			db.prisma.invitation.updateMany.mockResolvedValue({ count: 1 });
			db.prisma.user.updateMany.mockResolvedValue({ count: 0 });
			db.prisma.session.create.mockResolvedValue({ id: 'session-case-match' });

			await expect(
				runRegister(
					{ set: vi.fn() },
					{ email: 'Cible@Example.TEST', password: 'mot-de-passe-long' },
					{ user: null },
					'case-insensitive-invite-token'
				)
			).rejects.toMatchObject({ status: 303 });
		}
	);
});

describe('/register load', () => {
	afterEach(() => {
		privateEnv.env.REGISTRATION_MODE = undefined;
		vi.clearAllMocks();
	});

	it('admin_only mode: keeps the userCount===0/ADMIN guard active (unchanged behavior)', async () => {
		expect.assertions(1);

		db.prisma.user.count.mockResolvedValue(2);
		db.prisma.user.findUnique.mockResolvedValue(null);

		await expect(runLoad({ user: null })).rejects.toMatchObject({ status: 303 });
	});

	it('admin_only mode: allows the logged-in ADMIN even if users already exist', async () => {
		expect.assertions(1);

		db.prisma.user.count.mockResolvedValue(2);
		db.prisma.user.findUnique.mockResolvedValue(null);

		const result = await runLoad({ user: { role: 'ADMIN' } });

		expect(result.canRegister).toBe(true);
	});

	it('open mode: canRegister always true, even with existing users and without being ADMIN (guard bypassed)', async () => {
		expect.assertions(3);

		privateEnv.env.REGISTRATION_MODE = 'open';
		db.prisma.user.count.mockResolvedValue(5);

		const result = await runLoad({ user: null });

		expect(result.canRegister).toBe(true);
		expect(db.prisma.user.count).not.toHaveBeenCalled();
		expect(db.prisma.user.findUnique).not.toHaveBeenCalled();
	});

	it("token d'invitation valide en mode admin_only: bypasses the guard, exposes inviteEmail", async () => {
		expect.assertions(2);

		invitations.findValidInvitationByToken.mockResolvedValue({
			id: 'invite-load',
			email: 'cible@example.test'
		});

		const result = await runLoad({ user: null }, 'valid-token');

		expect(result.canRegister).toBe(true);
		expect(result.inviteEmail).toBe('cible@example.test');
	});

	it('invalid/expired invitation token: 410 error, no silent fallback', async () => {
		expect.assertions(1);

		invitations.findValidInvitationByToken.mockResolvedValue(null);
		db.prisma.user.count.mockResolvedValue(2);

		await expect(runLoad({ user: null }, 'expired-token')).rejects.toMatchObject({ status: 410 });
	});

	// The bounce to /login used to carry nothing, so a closed instance read as a broken link. The
	// reason travels in the redirect now, and /login allowlists the value rather than printing it.
	it('a closed instance says why it bounced you, in the redirect', async () => {
		expect.assertions(1);

		db.prisma.user.count.mockResolvedValue(2);
		db.prisma.user.findUnique.mockResolvedValue(null);

		await expect(runLoad({ user: null })).rejects.toMatchObject({
			status: 303,
			location: '/login?notice=registration_closed'
		});
	});

	// The server has NEVER asked an authenticated admin for BOOTSTRAP_TOKEN: the check in the
	// action is gated on `!locals.user`. The form asked anyway, so an admin arriving from /admin's
	// own "create a user" button was shown a field for the DEPLOYMENT secret that the server was
	// always going to ignore.
	it('does not ask an authenticated admin for the bootstrap token', async () => {
		expect.assertions(2);

		db.prisma.user.count.mockResolvedValue(2);
		db.prisma.user.findUnique.mockResolvedValue(null);

		const result = await runLoad({ user: { role: 'ADMIN' } });

		expect(result.canRegister).toBe(true);
		expect(result.requiresBootstrapToken).toBe(false);
	});

	it('asks for it on the first, unauthenticated account', async () => {
		expect.assertions(2);

		db.prisma.user.count.mockResolvedValue(0);
		db.prisma.user.findUnique.mockResolvedValue(null);

		const result = await runLoad({ user: null });

		expect(result.canRegister).toBe(true);
		expect(result.requiresBootstrapToken).toBe(true);
	});

	// Open mode never checks the token at all, so a field for it would be pure noise.
	it('does not ask for it in open mode', async () => {
		expect.assertions(1);

		privateEnv.env.REGISTRATION_MODE = 'open';

		const result = await runLoad({ user: null });

		expect(result.requiresBootstrapToken).toBe(false);
	});
});

async function runLoad(
	locals: { user: null | { role: string } },
	inviteToken?: string
): Promise<LoadResult> {
	const requestUrl = inviteToken
		? `http://localhost/register?invite=${inviteToken}`
		: 'http://localhost/register';

	return (await (
		load as unknown as (event: { locals: typeof locals; url: URL }) => Promise<LoadResult>
	)({
		locals,
		url: new URL(requestUrl)
	})) as LoadResult;
}

type LoadResult = {
	canRegister: boolean;
	inviteEmail: string | null;
	requiresBootstrapToken: boolean;
};

async function runRegister(
	cookies: { set: ReturnType<typeof vi.fn> },
	input: Record<string, string>,
	locals: { user: null | { role: string } } = { user: null },
	inviteToken?: string
) {
	const formData = new FormData();
	for (const [key, value] of Object.entries(input)) formData.set(key, value);
	const requestUrl = inviteToken
		? `http://localhost/register?invite=${inviteToken}`
		: 'http://localhost/register';

	return (await (
		actions.default as unknown as (event: {
			cookies: typeof cookies;
			getClientAddress: () => string;
			locals: typeof locals;
			request: Request;
			url: URL;
		}) => Promise<unknown>
	)({
		cookies,
		getClientAddress: () => '127.0.0.1',
		locals,
		request: new Request(requestUrl, {
			method: 'POST',
			body: formData
		}),
		url: new URL(requestUrl)
	})) as {
		status: number;
		data: { error?: string };
		success?: string;
	};
}
