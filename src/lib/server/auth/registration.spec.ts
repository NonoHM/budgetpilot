import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	prisma: {
		user: {
			count: vi.fn(),
			findUnique: vi.fn()
		}
	}
}));
const privateEnv = vi.hoisted(() => ({
	env: {
		REGISTRATION_MODE: undefined as string | undefined
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));
vi.mock('$env/dynamic/private', () => privateEnv);

const { BACKFILL_USER_EMAIL } = await import('$lib/server/auth');
const { getRegistrationMode, isSelfRegistrationOpen } = await import('./registration');

describe('getRegistrationMode', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		privateEnv.env.REGISTRATION_MODE = undefined;
	});

	it("retourne 'admin_only' quand la variable d'environnement est absente", () => {
		expect(getRegistrationMode()).toBe('admin_only');
	});

	it("retourne 'open' quand REGISTRATION_MODE vaut exactement 'open'", () => {
		privateEnv.env.REGISTRATION_MODE = 'open';

		expect(getRegistrationMode()).toBe('open');
	});

	it.each(['OPEN', 'Open', 'yes', 'true', '1', 'admin', ''])(
		"retombe en fail-safe sur 'admin_only' pour une valeur inconnue/typo (%s)",
		(value) => {
			privateEnv.env.REGISTRATION_MODE = value;

			expect(getRegistrationMode()).toBe('admin_only');
		}
	);
});

describe('isSelfRegistrationOpen', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		privateEnv.env.REGISTRATION_MODE = undefined;
	});

	it("retourne true immédiatement en mode 'open', sans interroger la base", async () => {
		expect.assertions(3);

		privateEnv.env.REGISTRATION_MODE = 'open';

		await expect(isSelfRegistrationOpen()).resolves.toBe(true);
		expect(db.prisma.user.count).not.toHaveBeenCalled();
		expect(db.prisma.user.findUnique).not.toHaveBeenCalled();
	});

	it('retourne true quand la base est vide', async () => {
		expect.assertions(1);

		db.prisma.user.count.mockResolvedValue(0);
		db.prisma.user.findUnique.mockResolvedValue(null);

		await expect(isSelfRegistrationOpen()).resolves.toBe(true);
	});

	it("retourne true quand seul l'utilisateur de backfill existe", async () => {
		expect.assertions(1);

		db.prisma.user.count.mockResolvedValue(1);
		db.prisma.user.findUnique.mockResolvedValue({ email: BACKFILL_USER_EMAIL });

		await expect(isSelfRegistrationOpen()).resolves.toBe(true);
	});

	it("retourne false dès qu'un utilisateur réel existe en plus du backfill", async () => {
		expect.assertions(1);

		db.prisma.user.count.mockResolvedValue(2);
		db.prisma.user.findUnique.mockResolvedValue({ email: BACKFILL_USER_EMAIL });

		await expect(isSelfRegistrationOpen()).resolves.toBe(false);
	});

	it("retourne false quand un seul utilisateur existe mais ce n'est pas le backfill", async () => {
		expect.assertions(1);

		db.prisma.user.count.mockResolvedValue(1);
		db.prisma.user.findUnique.mockResolvedValue(null);

		await expect(isSelfRegistrationOpen()).resolves.toBe(false);
	});
});
