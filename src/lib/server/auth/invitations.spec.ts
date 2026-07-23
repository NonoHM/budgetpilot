import { afterEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	prisma: {
		invitation: {
			create: vi.fn(),
			updateMany: vi.fn(),
			findUnique: vi.fn(),
			findMany: vi.fn()
		}
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { createInvitation, revokeInvitation, findValidInvitationByToken, listPendingInvitations } =
	await import('./invitations');

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const BASE64URL_TOKEN = /^[A-Za-z0-9_-]{40,}$/;

describe('createInvitation', () => {
	afterEach(() => {
		vi.clearAllMocks();
		delete process.env.INVITATION_TTL_HOURS;
	});

	it('génère un token aléatoire non stocké en clair (seul le hash va en DB)', async () => {
		expect.assertions(4);

		db.prisma.invitation.create.mockResolvedValue({ id: 'invite-a' });

		const result = await createInvitation('admin-a', null);

		expect(result.token).toMatch(BASE64URL_TOKEN);
		const createArgs = db.prisma.invitation.create.mock.calls[0][0];
		expect(createArgs.data.tokenHash).toMatch(HEX_SHA256);
		expect(createArgs.data.tokenHash).not.toBe(result.token);
		expect(createArgs.data.createdByUserId).toBe('admin-a');
	});

	it("normalise l'email cible (casse/espaces) avant stockage", async () => {
		expect.assertions(2);

		db.prisma.invitation.create.mockResolvedValue({ id: 'invite-b' });

		const result = await createInvitation('admin-a', '  User@Example.TEST  ');

		expect(result.email).toBe('user@example.test');
		expect(db.prisma.invitation.create.mock.calls[0][0].data.email).toBe('user@example.test');
	});

	it('lien générique : email null en DB', async () => {
		expect.assertions(1);

		db.prisma.invitation.create.mockResolvedValue({ id: 'invite-c' });

		await createInvitation('admin-a', null);

		expect(db.prisma.invitation.create.mock.calls[0][0].data.email).toBeNull();
	});

	it('expire après INVITATION_TTL_HOURS (par défaut 72h) à partir de maintenant', async () => {
		expect.assertions(1);

		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-08T00:00:00.000Z'));
		db.prisma.invitation.create.mockResolvedValue({ id: 'invite-d' });

		const result = await createInvitation('admin-a', null);

		expect(result.expiresAt).toEqual(new Date('2026-07-11T00:00:00.000Z'));
		vi.useRealTimers();
	});

	it('respecte INVITATION_TTL_HOURS si configuré', async () => {
		expect.assertions(1);

		process.env.INVITATION_TTL_HOURS = '2';
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-08T00:00:00.000Z'));
		db.prisma.invitation.create.mockResolvedValue({ id: 'invite-e' });

		const result = await createInvitation('admin-a', null);

		expect(result.expiresAt).toEqual(new Date('2026-07-08T02:00:00.000Z'));
		vi.useRealTimers();
	});
});

describe('revokeInvitation', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('révoque une invitation active (soft-delete via revokedAt)', async () => {
		expect.assertions(2);

		db.prisma.invitation.updateMany.mockResolvedValue({ count: 1 });

		await expect(revokeInvitation('invite-a')).resolves.toBe(true);
		expect(db.prisma.invitation.updateMany).toHaveBeenCalledWith({
			where: { id: 'invite-a', revokedAt: null, usedAt: null },
			data: { revokedAt: expect.any(Date) }
		});
	});

	it('ne révoque pas une invitation déjà consommée ou introuvable (count 0 -> false)', async () => {
		expect.assertions(1);

		db.prisma.invitation.updateMany.mockResolvedValue({ count: 0 });

		await expect(revokeInvitation('invite-used')).resolves.toBe(false);
	});
});

describe('findValidInvitationByToken', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('retourne null pour un token vide sans requête DB', async () => {
		expect.assertions(2);

		await expect(findValidInvitationByToken('')).resolves.toBeNull();
		expect(db.prisma.invitation.findUnique).not.toHaveBeenCalled();
	});

	it('retourne null si le token ne correspond à aucune invitation', async () => {
		expect.assertions(1);

		db.prisma.invitation.findUnique.mockResolvedValue(null);

		await expect(findValidInvitationByToken('unknown-token')).resolves.toBeNull();
	});

	it('retourne null si déjà utilisée', async () => {
		expect.assertions(1);

		db.prisma.invitation.findUnique.mockResolvedValue({
			id: 'invite-a',
			email: null,
			usedAt: new Date(),
			revokedAt: null,
			expiresAt: new Date(Date.now() + 1000 * 60)
		});

		await expect(findValidInvitationByToken('used-token')).resolves.toBeNull();
	});

	it('retourne null si révoquée', async () => {
		expect.assertions(1);

		db.prisma.invitation.findUnique.mockResolvedValue({
			id: 'invite-a',
			email: null,
			usedAt: null,
			revokedAt: new Date(),
			expiresAt: new Date(Date.now() + 1000 * 60)
		});

		await expect(findValidInvitationByToken('revoked-token')).resolves.toBeNull();
	});

	it('retourne null si expirée', async () => {
		expect.assertions(1);

		db.prisma.invitation.findUnique.mockResolvedValue({
			id: 'invite-a',
			email: null,
			usedAt: null,
			revokedAt: null,
			expiresAt: new Date(Date.now() - 1000)
		});

		await expect(findValidInvitationByToken('expired-token')).resolves.toBeNull();
	});

	it('retourne { id, email } pour une invitation valide, et hache le token en lookup (jamais en clair)', async () => {
		expect.assertions(2);

		db.prisma.invitation.findUnique.mockResolvedValue({
			id: 'invite-a',
			email: 'cible@example.test',
			usedAt: null,
			revokedAt: null,
			expiresAt: new Date(Date.now() + 1000 * 60)
		});

		await expect(findValidInvitationByToken('valid-token')).resolves.toEqual({
			id: 'invite-a',
			email: 'cible@example.test'
		});
		expect(db.prisma.invitation.findUnique.mock.calls[0][0].where.tokenHash).toMatch(HEX_SHA256);
	});
});

describe('listPendingInvitations', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('ne liste que les invitations ni utilisées ni révoquées', async () => {
		expect.assertions(1);

		db.prisma.invitation.findMany.mockResolvedValue([]);

		await listPendingInvitations();

		expect(db.prisma.invitation.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { usedAt: null, revokedAt: null } })
		);
	});
});
