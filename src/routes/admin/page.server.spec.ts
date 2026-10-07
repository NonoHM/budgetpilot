import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tx = vi.hoisted(() => ({
	session: {
		deleteMany: vi.fn()
	},
	pendingMfaChallenge: {
		deleteMany: vi.fn(async () => ({ count: 0 }))
	},
	transaction: {
		deleteMany: vi.fn()
	},
	user: {
		delete: vi.fn(),
		update: vi.fn()
	}
}));

const db = vi.hoisted(() => ({
	prisma: {
		user: {
			findMany: vi.fn(),
			findUnique: vi.fn(),
			count: vi.fn(),
			// The step a valid code records (#818): accepted. The engine's answer is
			// `totpSingleUse.db-smoke.ts`'s; here the re-authentication's outcome is what is tested.
			updateMany: vi.fn(async () => ({ count: 1 }))
		},
		$transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
	}
}));
const invitations = vi.hoisted(() => ({
	createInvitation: vi.fn(),
	revokeInvitation: vi.fn(),
	listPendingInvitations: vi.fn(async () => [])
}));

// The shared re-auth limiter, mocked as in settings/page.server.spec.ts: these specs cover the
// ORCHESTRATION of the two gated admin actions, and the limiter's SQL is rateLimit.spec.ts's.
const rateLimit = vi.hoisted(() => ({
	isReauthRateLimited: vi.fn(async () => false),
	recordReauthAttempt: vi.fn(async () => {})
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));
vi.mock('$lib/server/auth/invitations', () => invitations);
vi.mock('$lib/server/auth/rateLimit', () => rateLimit);
// The commit rotates the ADMIN's session token in the same transaction (#249). The rotation is
// `sessionRotation.db-smoke.ts`'s, against a real engine, where both actions are driven through this
// route. Here the commit runs the change on the fake transaction and rotates nothing.
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
// The helper runs for real; the spy only exposes the REASON it decided, which no response carries.
vi.mock('$lib/server/auth/reauth', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/auth/reauth')>();
	return { ...actual, reauthenticate: vi.fn(actual.reauthenticate) };
});

const { generateTemporaryPassword, hashPassword, validatePassword } =
	await import('$lib/server/auth');
const { actions, load } = await import('./+page.server');
const reauth = await import('$lib/server/auth/reauth');

const ADMIN = {
	id: 'admin-a',
	email: 'admin@example.test',
	role: 'ADMIN',
	forcePasswordChange: false,
	sessionId: 'session-a'
};
const USER = {
	id: 'user-a',
	email: 'user-a@example.test',
	role: 'USER',
	forcePasswordChange: false,
	sessionId: 'session-a'
};

/** The ADMIN's own password: #229 re-authenticates the admin, never the target. */
const ADMIN_PASSWORD = 'mot-de-passe-administrateur';
const adminPasswordHash = await hashPassword(ADMIN_PASSWORD);

/**
 * `findUnique` answers two different reads on these actions: the helper's read of the admin, and
 * the action's read of the target. Routed by the id asked for, so neither can be satisfied by the
 * other's fixture.
 */
function accountsAre(target: Record<string, unknown> | null) {
	db.prisma.user.findUnique.mockImplementation((async ({ where }: { where: { id: string } }) =>
		where.id === ADMIN.id
			? { passwordHash: adminPasswordHash, totpEnabled: false, totpSecretEncrypted: null }
			: target) as never);
}

describe('/admin load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.prisma.$transaction.mockImplementation(async (callback) => callback(tx));
	});

	it('rejette un utilisateur non-admin avec un 403', async () => {
		expect.assertions(1);

		await expect(
			(load as unknown as (event: { locals: { user: typeof USER }; url: URL }) => Promise<unknown>)(
				{
					locals: { user: USER },
					url: new URL('http://localhost/admin')
				}
			)
		).rejects.toMatchObject({ status: 403 });
	});

	it('rejette un utilisateur non connecté avec une redirection /login', async () => {
		expect.assertions(1);

		await expect(
			(load as unknown as (event: { locals: { user: null }; url: URL }) => Promise<unknown>)({
				locals: { user: null },
				url: new URL('http://localhost/admin')
			})
		).rejects.toMatchObject({ status: 303, location: '/login' });
	});

	it('liste tous les utilisateurs avec compteurs, sans données financières, et expose currentUserId et pagination', async () => {
		expect.assertions(4);

		db.prisma.user.count.mockResolvedValue(2);
		db.prisma.user.findMany.mockResolvedValue([
			{
				id: 'admin-a',
				email: 'admin@example.test',
				role: 'ADMIN',
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
				_count: { transactions: 3, categories: 5, monthlyBudgets: 2 }
			},
			{
				id: 'user-a',
				email: 'user-a@example.test',
				role: 'USER',
				createdAt: new Date('2026-02-01T00:00:00.000Z'),
				_count: { transactions: 10, categories: 8, monthlyBudgets: 1 }
			}
		]);

		const result = (await load({
			locals: { user: ADMIN },
			url: new URL('http://localhost/admin')
		} as never)) as {
			currentUserId: string;
			users: Array<Record<string, unknown>>;
			pagination: {
				page: number;
				totalPages: number;
				totalUsers: number;
				hasPrevious: boolean;
				hasNext: boolean;
			};
		};

		expect(result.currentUserId).toBe('admin-a');
		expect(result.users).toEqual([
			{
				id: 'admin-a',
				email: 'admin@example.test',
				role: 'ADMIN',
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
				transactionCount: 3,
				categoryCount: 5,
				budgetCount: 2
			},
			{
				id: 'user-a',
				email: 'user-a@example.test',
				role: 'USER',
				createdAt: new Date('2026-02-01T00:00:00.000Z'),
				transactionCount: 10,
				categoryCount: 8,
				budgetCount: 1
			}
		]);
		expect(db.prisma.user.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ skip: 0, take: 20 })
		);
		expect(result.pagination).toEqual({
			page: 1,
			totalPages: 1,
			totalUsers: 2,
			hasPrevious: false,
			hasNext: false
		});
	});

	it('page 1 par défaut avec plus de PAGE_SIZE utilisateurs : hasNext true, hasPrevious false', async () => {
		expect.assertions(3);

		db.prisma.user.count.mockResolvedValue(45);
		db.prisma.user.findMany.mockResolvedValue([]);

		const result = (await load({
			locals: { user: ADMIN },
			url: new URL('http://localhost/admin')
		} as never)) as {
			pagination: { page: number; totalPages: number; hasPrevious: boolean; hasNext: boolean };
		};

		expect(db.prisma.user.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ skip: 0, take: 20 })
		);
		expect(result.pagination.hasPrevious).toBe(false);
		expect(result.pagination.hasNext).toBe(true);
	});

	it('?page=2 calcule le bon skip', async () => {
		expect.assertions(3);

		db.prisma.user.count.mockResolvedValue(45);
		db.prisma.user.findMany.mockResolvedValue([]);

		const result = (await load({
			locals: { user: ADMIN },
			url: new URL('http://localhost/admin?page=2')
		} as never)) as {
			pagination: { page: number; hasPrevious: boolean; hasNext: boolean };
		};

		expect(db.prisma.user.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ skip: 20, take: 20 })
		);
		expect(result.pagination.page).toBe(2);
		expect(result.pagination.hasPrevious).toBe(true);
	});

	it('une page au-delà du total est clampée à la dernière page valide (safePage)', async () => {
		expect.assertions(2);

		db.prisma.user.count.mockResolvedValue(45);
		db.prisma.user.findMany.mockResolvedValue([]);

		const result = (await load({
			locals: { user: ADMIN },
			url: new URL('http://localhost/admin?page=999')
		} as never)) as {
			pagination: { page: number; totalPages: number; hasNext: boolean };
		};

		expect(result.pagination.page).toBe(3);
		expect(db.prisma.user.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ skip: 40, take: 20 })
		);
	});
});

describe('/admin action deleteUser', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.prisma.$transaction.mockImplementation(async (callback) => callback(tx));
	});

	it('rejette un utilisateur non-admin (garde indépendante de load)', async () => {
		expect.assertions(1);

		await expect(runDeleteUser({ targetUserId: 'user-b' }, USER)).rejects.toMatchObject({
			status: 403
		});
	});

	it("bloque l'auto-suppression avec un message explicite renvoyant vers Réglages, sans toucher la DB", async () => {
		expect.assertions(3);

		const result = await runDeleteUser({ targetUserId: ADMIN.id }, ADMIN);

		expect(result.status).toBe(400);
		expect(result.data.deleteError).toMatch(/Réglages/);
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
	});

	it("renvoie 404 si l'utilisateur cible n'existe pas", async () => {
		expect.assertions(2);

		accountsAre(null);

		const result = await runDeleteUser(
			{ targetUserId: 'inconnu', currentPassword: ADMIN_PASSWORD },
			ADMIN
		);

		expect(result.status).toBe(404);
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
	});

	it("supprime les sessions puis le compte de l'utilisateur cible", async () => {
		expect.assertions(5);

		accountsAre({ id: 'user-b' });
		tx.session.deleteMany.mockResolvedValue({ count: 1 });
		tx.transaction.deleteMany.mockResolvedValue({ count: 3 });
		tx.user.delete.mockResolvedValue({ id: 'user-b' });

		const result = await runDeleteUser(
			{ targetUserId: 'user-b', currentPassword: ADMIN_PASSWORD },
			ADMIN
		);

		expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-b' } });
		expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: 'user-b' } });
		expect(result).toEqual({ deleteSuccess: expect.any(String) });

		// Transactions BEFORE the user, and the ORDER is the assertion rather than the call.
		// Deleting a user cascades into Category and Transaction in whatever order the engine
		// picks, and TransactionSplit is RESTRICT on Category — so on PostgreSQL the bare
		// `user.delete` fails outright for anyone who has ever split a transaction. Measured on
		// three engines in transactions/splits.db-smoke.ts; pinned here so the line cannot be
		// removed as redundant.
		expect(tx.transaction.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-b' } });
		expect(tx.transaction.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
			tx.user.delete.mock.invocationCallOrder[0]
		);
	});
});

describe('/admin action resetPassword', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.prisma.$transaction.mockImplementation(async (callback) => callback(tx));
	});

	it('rejette un utilisateur non-admin (garde indépendante de load)', async () => {
		expect.assertions(1);

		await expect(runResetPassword({ targetUserId: 'user-b' }, USER)).rejects.toMatchObject({
			status: 403
		});
	});

	it("renvoie 404 si l'utilisateur cible n'existe pas", async () => {
		expect.assertions(2);

		accountsAre(null);

		const result = await runResetPassword(
			{ targetUserId: 'inconnu', currentPassword: ADMIN_PASSWORD },
			ADMIN
		);

		expect(result.status).toBe(404);
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
	});

	it("bloque l'auto-réinitialisation avec un message explicite renvoyant vers Réglages, sans toucher la DB", async () => {
		expect.assertions(3);

		const result = await runResetPassword({ targetUserId: ADMIN.id }, ADMIN);

		expect(result.status).toBe(400);
		expect(result.data.resetError).toMatch(/Réglages/);
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
	});

	it('generateTemporaryPassword() produit un mot de passe accepté par validatePassword()', () => {
		expect.assertions(1);

		expect(validatePassword(generateTemporaryPassword())).toBe(true);
	});

	it('réinitialise le mot de passe : passwordHash bcrypt stocké en DB (jamais le mot de passe en clair), forcePasswordChange activé, sessions révoquées, mot de passe en clair renvoyé une seule fois', async () => {
		expect.assertions(9);

		accountsAre({ id: 'user-b', email: 'user-b@example.test' });
		tx.user.update.mockResolvedValue({ id: 'user-b' });
		tx.session.deleteMany.mockResolvedValue({ count: 3 });
		const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const result = await runResetPassword(
			{ targetUserId: 'user-b', currentPassword: ADMIN_PASSWORD },
			ADMIN
		);

		expect(result.resetTargetUserId).toBe('user-b');
		expect(result.resetTargetEmail).toBe('user-b@example.test');
		expect(typeof result.temporaryPassword).toBe('string');
		expect(validatePassword(result.temporaryPassword)).toBe(true);

		const updateArgs = tx.user.update.mock.calls[0][0];
		expect(updateArgs.where).toEqual({ id: 'user-b' });
		expect(updateArgs.data.passwordHash).toMatch(/^\$2[aby]\$/);
		expect(updateArgs.data.passwordHash).not.toBe(result.temporaryPassword);
		expect(updateArgs.data.forcePasswordChange).toBe(true);
		expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-b' } });

		consoleLogSpy.mockRestore();
		consoleWarnSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});

	it('ne logge jamais le mot de passe temporaire en clair sur la console', async () => {
		expect.assertions(1);

		accountsAre({ id: 'user-b', email: 'user-b@example.test' });
		tx.user.update.mockResolvedValue({ id: 'user-b' });
		tx.session.deleteMany.mockResolvedValue({ count: 0 });
		const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const result = await runResetPassword(
			{ targetUserId: 'user-b', currentPassword: ADMIN_PASSWORD },
			ADMIN
		);

		const allLoggedArgs = [
			...consoleLogSpy.mock.calls,
			...consoleWarnSpy.mock.calls,
			...consoleErrorSpy.mock.calls
		]
			.flat()
			.map((arg) => JSON.stringify(arg))
			.join('\n');

		expect(allLoggedArgs).not.toContain(result.temporaryPassword);

		consoleLogSpy.mockRestore();
		consoleWarnSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});
});

describe('/admin action createInvitation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejette un utilisateur non-admin', async () => {
		expect.assertions(1);

		await expect(runCreateInvitation({}, USER)).rejects.toMatchObject({ status: 403 });
	});

	it('crée un lien générique (email vide) et retourne une URL contenant /register?invite=', async () => {
		expect.assertions(4);

		invitations.createInvitation.mockResolvedValue({
			id: 'invite-a',
			token: 'the-raw-token',
			email: null,
			expiresAt: new Date('2026-07-11T00:00:00.000Z')
		});

		const result = await runCreateInvitation({}, ADMIN);

		expect(invitations.createInvitation).toHaveBeenCalledWith('admin-a', null);
		expect(result.inviteUrl).toContain('/register?invite=the-raw-token');
		expect(result.inviteEmail).toBeNull();
		expect(result.inviteExpiresAt).toBe('2026-07-11T00:00:00.000Z');
	});

	it('crée une invitation nominative avec un email valide', async () => {
		expect.assertions(1);

		invitations.createInvitation.mockResolvedValue({
			id: 'invite-b',
			token: 'tok',
			email: 'cible@example.test',
			expiresAt: new Date()
		});

		await runCreateInvitation({ email: 'Cible@Example.TEST' }, ADMIN);

		expect(invitations.createInvitation).toHaveBeenCalledWith('admin-a', 'cible@example.test');
	});

	it('rejette un email invalide sans appeler createInvitation', async () => {
		expect.assertions(2);

		const result = await runCreateInvitation({ email: 'pas-un-email' }, ADMIN);

		expect(result.status).toBe(400);
		expect(invitations.createInvitation).not.toHaveBeenCalled();
	});
});

describe('/admin action revokeInvitation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejette un utilisateur non-admin', async () => {
		expect.assertions(1);

		await expect(runRevokeInvitation({ invitationId: 'invite-a' }, USER)).rejects.toMatchObject({
			status: 403
		});
	});

	it('révoque une invitation existante', async () => {
		expect.assertions(1);

		invitations.revokeInvitation.mockResolvedValue(true);

		const result = await runRevokeInvitation({ invitationId: 'invite-a' }, ADMIN);

		expect(result.revokeInviteSuccess).toEqual(expect.any(String));
	});

	it("renvoie 404 si l'invitation est introuvable ou déjà consommée/révoquée", async () => {
		expect.assertions(1);

		invitations.revokeInvitation.mockResolvedValue(false);

		const result = await runRevokeInvitation({ invitationId: 'invite-b' }, ADMIN);

		expect(result.status).toBe(404);
	});
});

/**
 * #229: the admin's two actions on ANOTHER account, through the real action, with every refusal
 * reason. The admin here has a second factor, so all four reasons are reachable; the target's
 * secrets are never asked for, and a test below proves the helper read the ADMIN's row.
 *
 * Same four observations as the settings block (reason, one sentence, no write, attempt counted
 * only for a wrong factor), and the same calibration that makes « no write » able to fail.
 */
describe('#229: the admin re-authenticates before acting on another account', () => {
	type AdminReauthAction = 'deleteUser' | 'resetPassword';
	const ACTIONS: AdminReauthAction[] = ['deleteUser', 'resetPassword'];
	const REASONS = ['wrong-password', 'missing-password', 'missing-totp', 'wrong-totp'] as const;
	const ROWS = ACTIONS.flatMap((action) => REASONS.map((reason) => [action, reason]));
	const ERROR_KEY = { deleteUser: 'deleteError', resetPassword: 'resetError' } as const;

	let secret = '';
	let secretEncrypted = '';

	async function totpCode(offsetSteps = 0): Promise<string> {
		const OTPAuth = await import('otpauth');
		return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate({
			timestamp: Date.now() + offsetSteps * 30_000
		});
	}

	async function credentials(
		reason: 'right' | (typeof REASONS)[number]
	): Promise<Record<string, string>> {
		switch (reason) {
			case 'right':
				return { currentPassword: ADMIN_PASSWORD, code: await totpCode() };
			case 'wrong-password':
				return { currentPassword: 'pas-le-bon', code: await totpCode() };
			case 'missing-password':
				return { code: await totpCode() };
			case 'missing-totp':
				return { currentPassword: ADMIN_PASSWORD };
			case 'wrong-totp':
				return { currentPassword: ADMIN_PASSWORD, code: await totpCode(10) };
		}
	}

	function writes() {
		return [tx.user.delete, tx.user.update, tx.session.deleteMany, tx.transaction.deleteMany];
	}

	beforeAll(async () => {
		const { generateTotpSecretBase32, encryptTotpSecret } = await import('$lib/server/auth/totp');
		secret = generateTotpSecretBase32();
		secretEncrypted = encryptTotpSecret(secret);
	});

	beforeEach(() => {
		vi.clearAllMocks();
		db.prisma.$transaction.mockImplementation(async (callback) => callback(tx));
		rateLimit.isReauthRateLimited.mockReset();
		rateLimit.isReauthRateLimited.mockResolvedValue(false);
		rateLimit.recordReauthAttempt.mockReset();
		rateLimit.recordReauthAttempt.mockResolvedValue(undefined);
		db.prisma.user.findUnique.mockImplementation((async ({ where }: { where: { id: string } }) =>
			where.id === ADMIN.id
				? {
						passwordHash: adminPasswordHash,
						totpEnabled: true,
						totpSecretEncrypted: secretEncrypted
					}
				: { id: 'user-b', email: 'user-b@example.test' }) as never);
	});

	it('covers exactly the registry entries that are actions of this route', () => {
		expect(Object.keys(reauth.REAUTH_FACTORS).filter((name) => name in actions)).toEqual(ACTIONS);
	});

	it.each(ACTIONS)('calibration: %s with the right secrets reaches its write', async (action) => {
		await invokeAction(action, { targetUserId: 'user-b', ...(await credentials('right')) }, ADMIN);

		await expect(vi.mocked(reauth.reauthenticate).mock.results[0]?.value).resolves.toEqual({
			ok: true
		});
		expect(writes().some((write) => write.mock.calls.length > 0)).toBe(true);
	});

	// The secrets checked are the ADMIN's: the helper is handed the admin's id, never the target's.
	it.each(ACTIONS)('%s proves the admin, not the target', async (action) => {
		await invokeAction(action, { targetUserId: 'user-b', ...(await credentials('right')) }, ADMIN);

		expect(vi.mocked(reauth.reauthenticate).mock.calls[0]?.[1]).toMatchObject({
			user: { id: ADMIN.id, sessionId: ADMIN.sessionId }
		});
	});

	it.each(ROWS)('%s refuses %s with its reason, one sentence, and no write', async (a, r) => {
		const action = a as AdminReauthAction;
		const reason = r as (typeof REASONS)[number];

		const result = await invokeAction(
			action,
			{ targetUserId: 'user-b', ...(await credentials(reason)) },
			ADMIN
		);

		const decided = await vi.mocked(reauth.reauthenticate).mock.results[0]?.value;
		expect(decided).toMatchObject({ ok: false, reason });
		expect(result.status).toBe(400);
		expect(result.data[ERROR_KEY[action]]).toBe(reauth.reauthRefusalMessage(decided));
		for (const write of writes()) expect(write.mock.calls).toEqual([]);
		expect(rateLimit.recordReauthAttempt).toHaveBeenCalledTimes(reason.startsWith('wrong') ? 1 : 0);
		if (reason.startsWith('wrong')) {
			expect(rateLimit.recordReauthAttempt).toHaveBeenCalledWith('session-a', '203.0.113.20');
		}
	});

	it.each(ACTIONS)('%s says the same sentence whatever failed', async (action) => {
		const sentences = new Set<string | undefined>();
		for (const reason of REASONS) {
			const result = await invokeAction(
				action,
				{ targetUserId: 'user-b', ...(await credentials(reason)) },
				ADMIN
			);
			sentences.add(result.data[ERROR_KEY[action]]);
		}

		expect(sentences.size).toBe(1);
	});

	// Ahead of the target lookup: a session alone cannot learn whether an id names an account.
	it.each(ACTIONS)('%s refuses before it reads the target', async (action) => {
		await invokeAction(action, { targetUserId: 'user-b', currentPassword: 'pas-le-bon' }, ADMIN);

		const idsRead = db.prisma.user.findUnique.mock.calls.map(
			(call) => (call[0] as { where: { id: string } }).where.id
		);
		expect(idsRead).toEqual([ADMIN.id]);
	});
});

async function runDeleteUser(input: Record<string, string>, user: typeof ADMIN | typeof USER) {
	return invokeAction('deleteUser', input, user);
}

async function runResetPassword(input: Record<string, string>, user: typeof ADMIN | typeof USER) {
	return invokeAction('resetPassword', input, user);
}

async function runCreateInvitation(
	input: Record<string, string>,
	user: typeof ADMIN | typeof USER
) {
	return invokeAction('createInvitation', input, user);
}

async function runRevokeInvitation(
	input: Record<string, string>,
	user: typeof ADMIN | typeof USER
) {
	return invokeAction('revokeInvitation', input, user);
}

async function invokeAction(
	name: keyof typeof actions,
	input: Record<string, string>,
	user: typeof ADMIN | typeof USER
) {
	const formData = new FormData();
	for (const [key, value] of Object.entries(input)) formData.set(key, value);

	return (await (
		actions[name] as unknown as (event: {
			getClientAddress: () => string;
			locals: { user: typeof ADMIN | typeof USER };
			request: Request;
		}) => Promise<unknown>
	)({
		getClientAddress: () => '203.0.113.20',
		locals: { user },
		request: new Request('http://localhost/admin', { method: 'POST', body: formData })
	})) as {
		status: number;
		data: {
			deleteError?: string;
			resetError?: string;
			inviteError?: string;
			revokeInviteError?: string;
		};
		deleteSuccess?: string;
		resetTargetUserId?: string;
		resetTargetEmail?: string;
		temporaryPassword: string;
		inviteUrl?: string;
		inviteEmail?: string | null;
		inviteExpiresAt?: string;
		revokeInviteSuccess?: string;
	};
}

/**
 * Every action on this route refuses a non-admin, ENUMERATED FROM THE MODULE.
 *
 * Each action already has its own hand-written 403 test above, and all of them pass. This block
 * is not for the actions that exist: it is for the one somebody adds next. `requireAdmin` is
 * called per action rather than enforced by a hook (#246), so an action written without the call
 * is open to any signed-in user, and nothing in the suite would redden.
 *
 * `Object.keys(actions)` is the whole point, and a literal list here would be the same manual
 * maintenance one level up: it would need updating by exactly the person who just forgot the
 * guard. An anti-drift test that has to be edited to cover a new case does not guard the new
 * case.
 *
 * `load` is deliberately absent: it has its own 403 test in "/admin load" above, and it takes a
 * different event shape (url, no request), so folding it in here would mean a second invocation
 * path and a cast per branch for no coverage gain.
 *
 * Seen red before being trusted: with `requireAdmin` removed from `revokeInvitation`, this block
 * fails on that action alone and every other case stays green.
 */
describe('/admin action guards, enumerated', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.prisma.$transaction.mockImplementation(async (callback) => callback(tx));
	});

	// The calibration, and it runs first. `it.each` over an empty array registers no cases and
	// reports a green file, which is indistinguishable from every action being guarded.
	it('finds the actions on the module rather than an empty object', () => {
		expect(Object.keys(actions).length).toBeGreaterThanOrEqual(4);
	});

	it.each(Object.keys(actions))('%s refuses a non-admin with 403', async (name) => {
		expect.assertions(1);

		// Empty input on purpose: the guard must fire before anything reads the form, so a missing
		// field must not be what produces the failure. An action that validated first would return
		// a 400 here and fail this assertion, which is the correct outcome — the check belongs
		// ahead of the parse.
		await expect(invokeAction(name as keyof typeof actions, {}, USER)).rejects.toMatchObject({
			status: 403
		});
	});
});
