import { beforeEach, describe, expect, it, vi } from 'vitest';

const tx = vi.hoisted(() => ({
	session: {
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
			count: vi.fn()
		},
		$transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
	}
}));
const invitations = vi.hoisted(() => ({
	createInvitation: vi.fn(),
	revokeInvitation: vi.fn(),
	listPendingInvitations: vi.fn(async () => [])
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));
vi.mock('$lib/server/auth/invitations', () => invitations);

const { generateTemporaryPassword, validatePassword } = await import('$lib/server/auth');
const { actions, load } = await import('./+page.server');

const ADMIN = {
	id: 'admin-a',
	email: 'admin@example.test',
	role: 'ADMIN',
	forcePasswordChange: false
};
const USER = {
	id: 'user-a',
	email: 'user-a@example.test',
	role: 'USER',
	forcePasswordChange: false
};

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

		db.prisma.user.findUnique.mockResolvedValue(null);

		const result = await runDeleteUser({ targetUserId: 'inconnu' }, ADMIN);

		expect(result.status).toBe(404);
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
	});

	it("supprime les sessions puis le compte de l'utilisateur cible", async () => {
		expect.assertions(3);

		db.prisma.user.findUnique.mockResolvedValue({ id: 'user-b' });
		tx.session.deleteMany.mockResolvedValue({ count: 1 });
		tx.user.delete.mockResolvedValue({ id: 'user-b' });

		const result = await runDeleteUser({ targetUserId: 'user-b' }, ADMIN);

		expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-b' } });
		expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: 'user-b' } });
		expect(result).toEqual({ deleteSuccess: expect.any(String) });
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

		db.prisma.user.findUnique.mockResolvedValue(null);

		const result = await runResetPassword({ targetUserId: 'inconnu' }, ADMIN);

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

		db.prisma.user.findUnique.mockResolvedValue({ id: 'user-b', email: 'user-b@example.test' });
		tx.user.update.mockResolvedValue({ id: 'user-b' });
		tx.session.deleteMany.mockResolvedValue({ count: 3 });
		const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const result = await runResetPassword({ targetUserId: 'user-b' }, ADMIN);

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

		db.prisma.user.findUnique.mockResolvedValue({ id: 'user-b', email: 'user-b@example.test' });
		tx.user.update.mockResolvedValue({ id: 'user-b' });
		tx.session.deleteMany.mockResolvedValue({ count: 0 });
		const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const result = await runResetPassword({ targetUserId: 'user-b' }, ADMIN);

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
			locals: { user: typeof ADMIN | typeof USER };
			request: Request;
		}) => Promise<unknown>
	)({
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
