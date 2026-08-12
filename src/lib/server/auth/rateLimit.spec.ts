import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
	process.env.RATE_LIMIT_HASH_SECRET ??= 'test-only-rate-limit-hash-secret';
});

const db = vi.hoisted(() => ({
	prisma: {
		loginAttempt: {
			count: vi.fn(),
			create: vi.fn(),
			deleteMany: vi.fn()
		}
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const {
	isLoginRateLimited,
	recordFailedLoginAttempt,
	isRegisterRateLimited,
	recordRegisterAttempt,
	isInviteRateLimited,
	recordInviteAttempt,
	isMfaRateLimited,
	recordMfaAttempt,
	isBankSyncStartRateLimited,
	recordBankSyncStartAttempt,
	isReauthRateLimited,
	recordReauthAttempt
} = await import('./rateLimit');

const HEX_SHA256 = /^[0-9a-f]{64}$/;

describe('isLoginRateLimited', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('retourne true si >= 5 tentatives par email dans les 15 dernières minutes', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count
			.mockResolvedValueOnce(5) // par email
			.mockResolvedValueOnce(0); // par ip

		await expect(isLoginRateLimited('user@example.test', '127.0.0.1')).resolves.toBe(true);
	});

	it('retourne true si >= 5 tentatives par IP dans les 15 dernières minutes', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count
			.mockResolvedValueOnce(0) // par email
			.mockResolvedValueOnce(5); // par ip

		await expect(isLoginRateLimited('user@example.test', '127.0.0.1')).resolves.toBe(true);
	});

	it('retourne false sous le seuil pour email et IP', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(4).mockResolvedValueOnce(4);

		await expect(isLoginRateLimited('user@example.test', '127.0.0.1')).resolves.toBe(false);
	});

	it('filtre les comptages sur la fenêtre glissante de 15 minutes en utilisant emailHash/ipHash', async () => {
		expect.assertions(6);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

		await isLoginRateLimited('user@example.test', '127.0.0.1');

		const emailArgs = db.prisma.loginAttempt.count.mock.calls[0][0];
		const ipArgs = db.prisma.loginAttempt.count.mock.calls[1][0];

		expect(emailArgs.where).not.toHaveProperty('emailKey');
		expect(ipArgs.where).not.toHaveProperty('ipKey');
		expect(emailArgs.where.emailHash).toMatch(HEX_SHA256);
		expect(ipArgs.where.ipHash).toMatch(HEX_SHA256);
		expect(emailArgs.where.emailHash).not.toBe('user@example.test');
		expect(ipArgs.where.ipHash).not.toBe('127.0.0.1');
	});

	it('hache la même valeur de façon déterministe (même email -> même hash)', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(0);

		await isLoginRateLimited('user@example.test', '127.0.0.1');
		const firstHash = db.prisma.loginAttempt.count.mock.calls[0][0].where.emailHash;

		await isLoginRateLimited('user@example.test', '127.0.0.1');
		const secondHash = db.prisma.loginAttempt.count.mock.calls[2][0].where.emailHash;

		expect(firstHash).toBe(secondHash);
	});

	it('hache différemment des valeurs différentes', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(0);

		await isLoginRateLimited('user@example.test', '127.0.0.1');
		const firstHash = db.prisma.loginAttempt.count.mock.calls[0][0].where.emailHash;

		await isLoginRateLimited('other@example.test', '127.0.0.1');
		const secondHash = db.prisma.loginAttempt.count.mock.calls[2][0].where.emailHash;

		expect(firstHash).not.toBe(secondHash);
	});

	it('normalise la casse et les espaces avant hachage (même hash pour "User@Example.test" et "user@example.test")', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(0);

		await isLoginRateLimited('User@Example.test', '127.0.0.1');
		const firstHash = db.prisma.loginAttempt.count.mock.calls[0][0].where.emailHash;

		await isLoginRateLimited('  user@example.test  ', '127.0.0.1');
		const secondHash = db.prisma.loginAttempt.count.mock.calls[2][0].where.emailHash;

		expect(firstHash).toBe(secondHash);
	});
});

describe('recordFailedLoginAttempt', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('crée une ligne LoginAttempt avec emailHash et ipHash hachés (pas les valeurs en clair)', async () => {
		expect.assertions(6);

		await recordFailedLoginAttempt('user@example.test', '127.0.0.1');

		expect(db.prisma.loginAttempt.create).toHaveBeenCalledTimes(1);
		const createArgs = db.prisma.loginAttempt.create.mock.calls[0][0];

		expect(createArgs.data).not.toHaveProperty('emailKey');
		expect(createArgs.data).not.toHaveProperty('ipKey');
		expect(createArgs.data.emailHash).toMatch(HEX_SHA256);
		expect(createArgs.data.ipHash).toMatch(HEX_SHA256);
		expect(createArgs.data.emailHash).not.toBe('user@example.test');
	});

	it('hache email/IP de façon déterministe et distincte entre appels différents', async () => {
		expect.assertions(2);

		await recordFailedLoginAttempt('user@example.test', '127.0.0.1');
		const first = db.prisma.loginAttempt.create.mock.calls[0][0].data;

		await recordFailedLoginAttempt('user@example.test', '127.0.0.1');
		const second = db.prisma.loginAttempt.create.mock.calls[1][0].data;

		await recordFailedLoginAttempt('other@example.test', '10.0.0.1');
		const third = db.prisma.loginAttempt.create.mock.calls[2][0].data;

		expect(first).toEqual(second);
		expect(first.emailHash).not.toBe(third.emailHash);
	});

	it('supprime les tentatives plus vieilles que 4x la fenêtre (1h)', async () => {
		expect.assertions(1);

		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-02T12:00:00.000Z'));

		await recordFailedLoginAttempt('user@example.test', '127.0.0.1');

		expect(db.prisma.loginAttempt.deleteMany).toHaveBeenCalledWith({
			where: { createdAt: { lt: new Date('2026-07-02T11:00:00.000Z') } }
		});
	});
});

describe('isRegisterRateLimited', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("retourne true si >= 5 tentatives d'inscription par IP dans les 15 dernières minutes", async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(5);

		await expect(isRegisterRateLimited('127.0.0.1')).resolves.toBe(true);
	});

	it('retourne false sous le seuil', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(4);

		await expect(isRegisterRateLimited('127.0.0.1')).resolves.toBe(false);
	});

	it("n'effectue qu'un seul comptage (par IP, pas par email) contrairement au login", async () => {
		expect.assertions(2);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(0);

		await isRegisterRateLimited('127.0.0.1');

		expect(db.prisma.loginAttempt.count).toHaveBeenCalledTimes(1);
		expect(db.prisma.loginAttempt.count.mock.calls[0][0].where).not.toHaveProperty('emailHash');
	});

	it("filtre par kind: 'REGISTER' pour ne pas compter les tentatives de login", async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(0);

		await isRegisterRateLimited('127.0.0.1');

		expect(db.prisma.loginAttempt.count.mock.calls[0][0].where.kind).toBe('REGISTER');
	});

	it('hache la même valeur de façon déterministe (même IP -> même hash)', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

		await isRegisterRateLimited('127.0.0.1');
		const firstHash = db.prisma.loginAttempt.count.mock.calls[0][0].where.ipHash;

		await isRegisterRateLimited('127.0.0.1');
		const secondHash = db.prisma.loginAttempt.count.mock.calls[1][0].where.ipHash;

		expect(firstHash).toBe(secondHash);
	});
});

describe('recordRegisterAttempt', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("crée une ligne LoginAttempt avec kind: 'REGISTER', emailHash null et ipHash haché", async () => {
		expect.assertions(4);

		await recordRegisterAttempt('127.0.0.1');

		expect(db.prisma.loginAttempt.create).toHaveBeenCalledTimes(1);
		const createArgs = db.prisma.loginAttempt.create.mock.calls[0][0];

		expect(createArgs.data.kind).toBe('REGISTER');
		expect(createArgs.data.emailHash).toBeNull();
		expect(createArgs.data.ipHash).toMatch(HEX_SHA256);
	});

	it("n'enregistre pas de tentative de kind 'LOGIN' quand on appelle recordRegisterAttempt", async () => {
		expect.assertions(1);

		await recordRegisterAttempt('127.0.0.1');

		expect(db.prisma.loginAttempt.create.mock.calls[0][0].data.kind).not.toBe('LOGIN');
	});

	it('supprime les tentatives plus vieilles que 4x la fenêtre (1h), comme pour le login', async () => {
		expect.assertions(1);

		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-02T12:00:00.000Z'));

		await recordRegisterAttempt('127.0.0.1');

		expect(db.prisma.loginAttempt.deleteMany).toHaveBeenCalledWith({
			where: { createdAt: { lt: new Date('2026-07-02T11:00:00.000Z') } }
		});
	});
});

describe('isInviteRateLimited / recordInviteAttempt', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('retourne true si >= 5 tentatives sur /register?invite= par IP', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(5);

		await expect(isInviteRateLimited('127.0.0.1')).resolves.toBe(true);
	});

	it("filtre par kind: 'INVITE', isolé de LOGIN/REGISTER", async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(0);

		await isInviteRateLimited('127.0.0.1');

		expect(db.prisma.loginAttempt.count.mock.calls[0][0].where.kind).toBe('INVITE');
	});

	it("recordInviteAttempt crée une ligne avec kind: 'INVITE' et ipHash haché", async () => {
		expect.assertions(2);

		await recordInviteAttempt('127.0.0.1');

		const createArgs = db.prisma.loginAttempt.create.mock.calls[0][0];
		expect(createArgs.data.kind).toBe('INVITE');
		expect(createArgs.data.ipHash).toMatch(HEX_SHA256);
	});
});

describe('isolation login/register par kind', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('une IP qui a épuisé son quota register peut toujours se logger (comptages indépendants)', async () => {
		expect.assertions(2);

		// isLoginRateLimited : compte email puis IP, toutes deux sous le seuil.
		db.prisma.loginAttempt.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
		await expect(isLoginRateLimited('user@example.test', '127.0.0.1')).resolves.toBe(false);

		const loginIpCall = db.prisma.loginAttempt.count.mock.calls[1][0];
		expect(loginIpCall.where.kind).toBe('LOGIN');
	});

	it('le login et le register hachent la même IP mais interrogent des kind distincts', async () => {
		expect.assertions(2);

		db.prisma.loginAttempt.count
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(0);

		await isLoginRateLimited('user@example.test', '127.0.0.1');
		const loginIpArgs = db.prisma.loginAttempt.count.mock.calls[1][0].where;

		await isRegisterRateLimited('127.0.0.1');
		const registerArgs = db.prisma.loginAttempt.count.mock.calls[2][0].where;

		expect(loginIpArgs.ipHash).toBe(registerArgs.ipHash);
		expect(loginIpArgs.kind).not.toBe(registerArgs.kind);
	});
});

describe('isMfaRateLimited', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('retourne true si >= 5 tentatives par id de challenge dans les 15 dernières minutes', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count
			.mockResolvedValueOnce(5) // par challenge id
			.mockResolvedValueOnce(0); // par ip

		await expect(isMfaRateLimited('challenge-1', '127.0.0.1')).resolves.toBe(true);
	});

	it('retourne true si >= 5 tentatives par IP, même sur des challenges différents', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count
			.mockResolvedValueOnce(0) // par challenge id
			.mockResolvedValueOnce(5); // par ip

		await expect(isMfaRateLimited('challenge-1', '127.0.0.1')).resolves.toBe(true);
	});

	it("retourne false sous le seuil pour le challenge et pour l'IP", async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(4).mockResolvedValueOnce(4);

		await expect(isMfaRateLimited('challenge-1', '127.0.0.1')).resolves.toBe(false);
	});

	it("filtre par kind: 'MFA', isolé de LOGIN/REGISTER/INVITE", async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

		await isMfaRateLimited('challenge-1', '127.0.0.1');

		expect(db.prisma.loginAttempt.count.mock.calls[0][0].where.kind).toBe('MFA');
	});

	it('un attaquant ne contourne pas la limite en générant un nouveau challenge depuis la même IP', async () => {
		expect.assertions(2);

		// Two different challenges (per-challenge count under the threshold each time),
		// but the IP has already hit the global threshold.
		db.prisma.loginAttempt.count
			.mockResolvedValueOnce(0) // challenge-1
			.mockResolvedValueOnce(5) // ip
			.mockResolvedValueOnce(0) // challenge-2
			.mockResolvedValueOnce(5); // ip

		await expect(isMfaRateLimited('challenge-1', '127.0.0.1')).resolves.toBe(true);
		await expect(isMfaRateLimited('challenge-2', '127.0.0.1')).resolves.toBe(true);
	});
});

describe('recordMfaAttempt', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("crée une ligne LoginAttempt avec kind: 'MFA', emailHash (challenge id) et ipHash hachés", async () => {
		expect.assertions(4);

		await recordMfaAttempt('challenge-1', '127.0.0.1');

		expect(db.prisma.loginAttempt.create).toHaveBeenCalledTimes(1);
		const createArgs = db.prisma.loginAttempt.create.mock.calls[0][0];

		expect(createArgs.data.kind).toBe('MFA');
		expect(createArgs.data.emailHash).toMatch(HEX_SHA256);
		expect(createArgs.data.ipHash).toMatch(HEX_SHA256);
	});
});

describe('isBankSyncStartRateLimited', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('retourne true si >= 5 tentatives par userId dans les 15 dernières minutes', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count
			.mockResolvedValueOnce(5) // par userId
			.mockResolvedValueOnce(0); // par ip

		await expect(isBankSyncStartRateLimited('user-1', '127.0.0.1')).resolves.toBe(true);
	});

	it('retourne true si >= 5 tentatives par IP, même sur des comptes différents', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count
			.mockResolvedValueOnce(0) // par userId
			.mockResolvedValueOnce(5); // par ip

		await expect(isBankSyncStartRateLimited('user-1', '127.0.0.1')).resolves.toBe(true);
	});

	it("retourne false sous le seuil pour le userId et pour l'IP", async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(4).mockResolvedValueOnce(4);

		await expect(isBankSyncStartRateLimited('user-1', '127.0.0.1')).resolves.toBe(false);
	});

	it("filtre par kind: 'BANK_SYNC_START', isolé de LOGIN/REGISTER/INVITE/MFA", async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

		await isBankSyncStartRateLimited('user-1', '127.0.0.1');

		expect(db.prisma.loginAttempt.count.mock.calls[0][0].where.kind).toBe('BANK_SYNC_START');
	});
});

describe('recordBankSyncStartAttempt', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("crée une ligne LoginAttempt avec kind: 'BANK_SYNC_START', emailHash (userId) et ipHash hachés", async () => {
		expect.assertions(4);

		await recordBankSyncStartAttempt('user-1', '127.0.0.1');

		expect(db.prisma.loginAttempt.create).toHaveBeenCalledTimes(1);
		const createArgs = db.prisma.loginAttempt.create.mock.calls[0][0];

		expect(createArgs.data.kind).toBe('BANK_SYNC_START');
		expect(createArgs.data.emailHash).toMatch(HEX_SHA256);
		expect(createArgs.data.ipHash).toMatch(HEX_SHA256);
	});
});

describe('isReauthRateLimited / recordReauthAttempt (shared settings re-auth limiter)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('retourne true si >= 5 tentatives par userId dans la fenêtre', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count
			.mockResolvedValueOnce(5) // par userId
			.mockResolvedValueOnce(0); // par ip

		await expect(isReauthRateLimited('user-1', '127.0.0.1')).resolves.toBe(true);
	});

	it('retourne true si >= 5 tentatives par IP, même sur des comptes différents', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count
			.mockResolvedValueOnce(0) // par userId
			.mockResolvedValueOnce(5); // par ip

		await expect(isReauthRateLimited('user-1', '127.0.0.1')).resolves.toBe(true);
	});

	it("retourne false sous le seuil pour le userId et pour l'IP", async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(4).mockResolvedValueOnce(4);

		await expect(isReauthRateLimited('user-1', '127.0.0.1')).resolves.toBe(false);
	});

	it("filtre par kind: 'REAUTH', isolé des autres compteurs", async () => {
		expect.assertions(2);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

		await isReauthRateLimited('user-1', '127.0.0.1');

		expect(db.prisma.loginAttempt.count.mock.calls[0][0].where.kind).toBe('REAUTH');
		expect(db.prisma.loginAttempt.count.mock.calls[1][0].where.kind).toBe('REAUTH');
	});

	it('utilise une fenêtre de 5 minutes, plus courte que les 15 minutes du login', async () => {
		expect.assertions(2);

		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-02T12:00:00.000Z'));

		db.prisma.loginAttempt.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
		await isReauthRateLimited('user-1', '127.0.0.1');

		// The distinctive property of this kind: a 5-minute sliding window (not 15), so an honest
		// owner locked out by five wrong attempts recovers three times faster and the escape hatch
		// (deleteAccount) reopens quickly.
		const userArgs = db.prisma.loginAttempt.count.mock.calls[0][0];
		const ipArgs = db.prisma.loginAttempt.count.mock.calls[1][0];
		expect(userArgs.where.createdAt.gte).toEqual(new Date('2026-07-02T11:55:00.000Z'));
		expect(ipArgs.where.createdAt.gte).toEqual(new Date('2026-07-02T11:55:00.000Z'));
	});

	it("recordReauthAttempt crée une ligne kind: 'REAUTH' avec userId et IP hachés", async () => {
		expect.assertions(4);

		await recordReauthAttempt('user-1', '127.0.0.1');

		expect(db.prisma.loginAttempt.create).toHaveBeenCalledTimes(1);
		const createArgs = db.prisma.loginAttempt.create.mock.calls[0][0];
		expect(createArgs.data.kind).toBe('REAUTH');
		expect(createArgs.data.emailHash).toMatch(HEX_SHA256);
		expect(createArgs.data.ipHash).toMatch(HEX_SHA256);
	});
});
