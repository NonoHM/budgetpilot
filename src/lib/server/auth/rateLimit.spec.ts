import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTRIBUTE, EVENT } from '$lib/server/logging/names';

vi.hoisted(() => {
	// 64 hex, because that is now enforced (assertRateLimitSecretConfigured). The previous literal
	// was a readable sentence, which is exactly the value the production check refuses.
	process.env.RATE_LIMIT_HASH_SECRET ??= 'a1'.repeat(32);
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

const logged = vi.hoisted(() => [] as unknown[]);
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: (event: unknown) => {
		logged.push(event);
	}
}));

const {
	claimLoginAttempt,
	claimMfaAttempt,
	settleAttempt,
	isRegisterRateLimited,
	recordRegisterAttempt,
	isInviteRateLimited,
	recordInviteAttempt,
	isBankSyncStartRateLimited,
	recordBankSyncStartAttempt,
	isReauthRateLimited,
	recordReauthAttempt,
	isImportRateLimited,
	recordImportAttempt,
	IMPORT_DEFAULT_MAX_ATTEMPTS,
	IMPORT_MAX_ATTEMPTS_CEILING,
	IMPORT_MAX_ATTEMPTS_ENV,
	HONEST_IMPORT_BATCH_ATTEMPTS,
	resolveImportMaxAttempts,
	assertImportRateLimitConfigured,
	assertRateLimitSecretConfigured
} = await import('./rateLimit');

// Loaded at module level rather than inside the tests that read them: the collector pulls in every
// boot check's module, and under a full parallel run that import alone outlasted the 5 s test
// timeout. Prisma is mocked above, so nothing here opens a database.
const { ENVIRONMENT_CHECKS } = await import('$lib/server/env/assertConfigured');
const { E2E_ENV } = await import('../../../../e2e/config');

const HEX_SHA256 = /^[0-9a-f]{64}$/;

interface Row {
	id: string;
	kind: string;
	emailHash: string | null;
	ipHash: string;
	createdAt: Date;
}

/**
 * The `LoginAttempt` table the claimed kinds need: a claim writes, counts its own row, and may
 * delete it, so canned answers per call cannot follow it. Models exactly the clauses the limiter
 * writes, an absent clause as no filter, as Prisma does, and THROWS on any other, so a clause it
 * cannot model is never read as « matches everything ».
 */
function installTable(): Row[] {
	const rows: Row[] = [];
	let next = 0;
	const refuse = (op: string, key: string) => {
		throw new Error(`the fake loginAttempt.${op} cannot model the clause ${key}`);
	};
	const matches = (row: Row, where: Record<string, unknown>, op: string) =>
		Object.entries(where).every(([key, value]) => {
			if (key === 'kind' || key === 'emailHash' || key === 'ipHash' || key === 'id') {
				return row[key] === value;
			}
			if (key === 'createdAt') {
				const bounds = value as Record<string, Date>;
				return Object.entries(bounds).every(([bound, at]) => {
					if (bound === 'gte') return row.createdAt.getTime() >= at.getTime();
					if (bound === 'lt') return row.createdAt.getTime() < at.getTime();
					return refuse(op, `createdAt.${bound}`);
				});
			}
			return refuse(op, key);
		});
	db.prisma.loginAttempt.create.mockImplementation(
		async ({ data }: { data: Omit<Row, 'id' | 'createdAt'> }) => {
			const row = { ...data, id: `row-${++next}`, createdAt: new Date() };
			rows.push(row);
			return { id: row.id };
		}
	);
	db.prisma.loginAttempt.count.mockImplementation(
		async ({ where = {} }: { where?: Record<string, unknown> }) =>
			rows.filter((row) => matches(row, where, 'count')).length
	);
	db.prisma.loginAttempt.deleteMany.mockImplementation(
		async ({ where = {} }: { where?: Record<string, unknown> }) => {
			const doomed = rows.filter((row) => matches(row, where, 'deleteMany'));
			for (const row of doomed) rows.splice(rows.indexOf(row), 1);
			return { count: doomed.length };
		}
	);
	return rows;
}

/** Back to bare mocks, for the blocks that answer counts per call. */
function uninstallTable() {
	db.prisma.loginAttempt.count.mockReset();
	db.prisma.loginAttempt.create.mockReset();
	db.prisma.loginAttempt.deleteMany.mockReset();
}

type ClaimAnswer = Awaited<ReturnType<typeof claimLoginAttempt>>;

function claimOf(answer: ClaimAnswer): { id: string } {
	if (!('claim' in answer))
		throw new Error(`expected an admitted claim, got ${JSON.stringify(answer)}`);
	return answer.claim;
}

/** `n` attempts judged wrong, through the claim and the settle the route performs. */
async function keepWrong(n: number, claim: (i: number) => Promise<ClaimAnswer>) {
	for (let i = 0; i < n; i++) await settleAttempt(claimOf(await claim(i)), true);
}

const EMAIL = 'user@example.test';
const IP = '127.0.0.1';
const RECOVERY = (challengeId: string) => ({ factor: 'recovery_code', challengeId }) as const;
const TOTP = (userId: string) => ({ factor: 'totp', userId }) as const;

describe('claimLoginAttempt', () => {
	let rows: Row[];
	beforeEach(() => {
		vi.clearAllMocks();
		rows = installTable();
	});
	afterEach(() => {
		uninstallTable();
		vi.useRealTimers();
	});

	it('refuse sur le compteur email après 5 tentatives fausses pour cet email', async () => {
		await keepWrong(5, (i) => claimLoginAttempt(EMAIL, `10.0.0.${i + 1}`));
		await expect(claimLoginAttempt(EMAIL, IP)).resolves.toEqual({ trip: { counter: 'subject' } });
	});

	it("refuse sur le compteur IP après 5 tentatives fausses depuis cette IP, quel que soit l'email", async () => {
		await keepWrong(5, (i) => claimLoginAttempt(`user${i}@example.test`, IP));
		await expect(claimLoginAttempt(EMAIL, IP)).resolves.toEqual({ trip: { counter: 'address' } });
	});

	// The boundary of the recount: four kept rows and the claim's own make five, which is the
	// maximum and admitted. A recount that does not allow for its own row refuses here.
	it('admet la cinquième tentative: 4 fausses par email et 4 par IP', async () => {
		await keepWrong(4, (i) => claimLoginAttempt(EMAIL, `10.0.0.${i + 1}`));
		await keepWrong(4, (i) => claimLoginAttempt(`user${i}@example.test`, IP));
		const answer = await claimLoginAttempt(EMAIL, IP);
		expect({ answer, rows: rows.length }).toEqual({ answer: { claim: { id: 'row-9' } }, rows: 9 });
	});

	it('filtre les comptages sur la fenêtre glissante de 15 minutes en utilisant emailHash/ipHash', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-02T12:00:00.000Z'));

		await claimLoginAttempt(EMAIL, IP);

		const wheres = db.prisma.loginAttempt.count.mock.calls.map((call) => call[0].where);
		const emailWhere = wheres.find((where) => 'emailHash' in where);
		const ipWhere = wheres.find((where) => 'ipHash' in where);
		expect(emailWhere).toEqual({
			emailHash: expect.stringMatching(HEX_SHA256),
			kind: 'LOGIN',
			createdAt: { gte: new Date('2026-07-02T11:45:00.000Z') }
		});
		expect(ipWhere).toEqual({
			ipHash: expect.stringMatching(HEX_SHA256),
			kind: 'LOGIN',
			createdAt: { gte: new Date('2026-07-02T11:45:00.000Z') }
		});
	});

	// Separates « the window slides » from « every row ever counts »: a row 15 minutes and 1 ms old
	// has left the window, one exactly 15 minutes old has not (`gte`).
	it("ne compte que les lignes de la fenêtre: une ligne vieille de 15 min + 1 ms n'en est plus", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-02T12:00:00.000Z'));
		await keepWrong(4, (i) => claimLoginAttempt(EMAIL, `10.0.0.${i + 1}`));
		vi.setSystemTime(new Date('2026-07-02T12:00:00.001Z'));
		await keepWrong(1, () => claimLoginAttempt(EMAIL, '10.0.0.9'));

		vi.setSystemTime(new Date('2026-07-02T12:15:00.001Z'));
		await settleAttempt(claimOf(await claimLoginAttempt(EMAIL, IP)), false);
		vi.setSystemTime(new Date('2026-07-02T12:15:00.000Z'));
		await expect(claimLoginAttempt(EMAIL, '10.0.0.10')).resolves.toEqual({
			trip: { counter: 'subject' }
		});
	});

	it('écrit une ligne avec emailHash et ipHash hachés (pas les valeurs en clair)', async () => {
		await claimLoginAttempt(EMAIL, IP);

		expect(db.prisma.loginAttempt.create).toHaveBeenCalledTimes(1);
		const { data } = db.prisma.loginAttempt.create.mock.calls[0][0];
		expect(data).toEqual({
			kind: 'LOGIN',
			emailHash: expect.stringMatching(HEX_SHA256),
			ipHash: expect.stringMatching(HEX_SHA256)
		});
		expect(JSON.stringify(data)).not.toContain(EMAIL);
		expect(JSON.stringify(data)).not.toContain(IP);
	});

	it('hache de façon déterministe (même email -> même hash) et distincte (autre email -> autre hash)', async () => {
		await claimLoginAttempt(EMAIL, IP);
		await claimLoginAttempt(EMAIL, IP);
		await claimLoginAttempt('other@example.test', '10.0.0.1');
		const [first, second, third] = db.prisma.loginAttempt.create.mock.calls.map(
			(call) => call[0].data
		);

		expect(first).toEqual(second);
		expect([third.emailHash === first.emailHash, third.ipHash === first.ipHash]).toEqual([
			false,
			false
		]);
	});

	it('normalise la casse et les espaces avant hachage (même hash pour "User@Example.test" et "user@example.test")', async () => {
		await claimLoginAttempt('User@Example.test', IP);
		await claimLoginAttempt('  user@example.test  ', IP);
		const [first, second] = db.prisma.loginAttempt.create.mock.calls.map((call) => call[0].data);

		expect(first.emailHash).toBe(second.emailHash);
	});
});

/**
 * THE CLAIM IS ONE DECISION (#714): the row first, then a count that holds it. The four halves of
 * that, each against the table rather than against canned counts, so a test reads what the table
 * holds afterwards.
 */
describe('claim and settle', () => {
	let rows: Row[];
	beforeEach(() => {
		vi.clearAllMocks();
		rows = installTable();
	});
	afterEach(() => {
		uninstallTable();
		vi.useRealTimers();
	});

	// Separates « a full counter is refused by a read » from « refused after writing a row », which
	// turns a flood on a full counter into a flood of writes.
	it('a claim on a full counter writes nothing', async () => {
		await keepWrong(5, (i) => claimLoginAttempt(EMAIL, `10.0.0.${i + 1}`));
		db.prisma.loginAttempt.create.mockClear();
		db.prisma.loginAttempt.deleteMany.mockClear();

		await expect(claimLoginAttempt(EMAIL, IP)).resolves.toEqual({ trip: { counter: 'subject' } });
		expect({
			creates: db.prisma.loginAttempt.create.mock.calls.length,
			deletes: db.prisma.loginAttempt.deleteMany.mock.calls.length,
			rows: rows.length
		}).toEqual({ creates: 0, deletes: 0, rows: 5 });
	});

	// A concurrent request's row lands between this claim's pre-check and its recount: the
	// pre-check read four, the recount reads six. Separates « refused, deleting its own row » from
	// « refused, keeping it » (a burst would then fill the counter with refusals) and from « deletes
	// by another clause » (the concurrent row, or every row of the counter).
	it('a claim that trips on the recount deletes exactly its own row', async () => {
		await keepWrong(4, (i) => claimLoginAttempt(EMAIL, `10.0.0.${i + 1}`));
		const table = db.prisma.loginAttempt.create.getMockImplementation()!;
		db.prisma.loginAttempt.create.mockImplementationOnce(async (args) => {
			const own = await table(args);
			await table({ data: { ...args.data, ipHash: 'concurrent' } });
			return own;
		});
		db.prisma.loginAttempt.deleteMany.mockClear();

		await expect(claimLoginAttempt(EMAIL, IP)).resolves.toEqual({ trip: { counter: 'subject' } });
		expect({
			deletes: db.prisma.loginAttempt.deleteMany.mock.calls,
			left: rows.map((row) => row.id)
		}).toEqual({
			deletes: [[{ where: { id: 'row-5' } }]],
			left: ['row-1', 'row-2', 'row-3', 'row-4', 'row-6']
		});
	});

	// Separates « a credential not judged wrong costs nothing » from « every claim counts », which
	// turns five honest sign-ins into a lockout.
	it("settle(false) deletes the claim's own row, and only it", async () => {
		await keepWrong(2, (i) => claimLoginAttempt(EMAIL, `10.0.0.${i + 1}`));
		const claim = claimOf(await claimLoginAttempt(EMAIL, IP));
		db.prisma.loginAttempt.deleteMany.mockClear();

		await settleAttempt(claim, false);

		expect({
			deletes: db.prisma.loginAttempt.deleteMany.mock.calls,
			left: rows.map((row) => row.id)
		}).toEqual({ deletes: [[{ where: { id: claim.id } }]], left: ['row-1', 'row-2'] });
	});

	// Separates « a wrong credential keeps its row » from « it is released too », which would leave
	// the limiter counting nothing; the one delete is the expired-rows cleanup, 4 windows back.
	it('settle(true) keeps the row and only clears rows older than 4 windows (1h)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-02T12:00:00.000Z'));
		const claim = claimOf(await claimLoginAttempt(EMAIL, IP));
		db.prisma.loginAttempt.deleteMany.mockClear();

		await settleAttempt(claim, true);

		expect({
			deletes: db.prisma.loginAttempt.deleteMany.mock.calls,
			left: rows.map((row) => row.id)
		}).toEqual({
			deletes: [[{ where: { createdAt: { lt: new Date('2026-07-02T11:00:00.000Z') } } }]],
			left: [claim.id]
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

		await expect(isRegisterRateLimited('127.0.0.1')).resolves.not.toBeNull();
	});

	it('retourne false sous le seuil', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(4);

		await expect(isRegisterRateLimited('127.0.0.1')).resolves.toBeNull();
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

		await expect(isInviteRateLimited('127.0.0.1')).resolves.not.toBeNull();
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
		installTable();
	});
	afterEach(() => {
		uninstallTable();
	});

	it('une IP qui a épuisé son quota register peut toujours se logger (comptages indépendants)', async () => {
		for (let i = 0; i < 5; i++) await recordRegisterAttempt(IP);
		await expect(isRegisterRateLimited(IP)).resolves.toEqual({ counter: 'address' });

		await expect(claimLoginAttempt(EMAIL, IP)).resolves.toHaveProperty('claim');
	});

	it('le login et le register hachent la même IP mais écrivent des kind distincts', async () => {
		await claimLoginAttempt(EMAIL, IP);
		await recordRegisterAttempt(IP);
		const [login, register] = db.prisma.loginAttempt.create.mock.calls.map((call) => call[0].data);

		expect(login.ipHash).toBe(register.ipHash);
		expect([login.kind, register.kind]).toEqual(['LOGIN', 'REGISTER']);
	});
});

describe('claimMfaAttempt', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		installTable();
	});
	afterEach(() => {
		uninstallTable();
	});

	it('refuse un code de récupération après 5 tentatives fausses sur ce challenge', async () => {
		await keepWrong(5, (i) => claimMfaAttempt(RECOVERY('challenge-1'), `10.0.0.${i + 1}`));
		await expect(claimMfaAttempt(RECOVERY('challenge-1'), IP)).resolves.toEqual({
			trip: { counter: 'subject' }
		});
	});

	it('refuse après 5 tentatives fausses depuis la même IP, même sur des challenges différents', async () => {
		await keepWrong(5, (i) => claimMfaAttempt(RECOVERY(`challenge-${i + 10}`), IP));
		await expect(claimMfaAttempt(RECOVERY('challenge-1'), IP)).resolves.toEqual({
			trip: { counter: 'address' }
		});
		await expect(claimMfaAttempt(RECOVERY('challenge-2'), IP)).resolves.toEqual({
			trip: { counter: 'address' }
		});
	});

	it("admet sous le seuil pour le challenge et pour l'IP", async () => {
		await keepWrong(4, (i) => claimMfaAttempt(RECOVERY('challenge-1'), `10.0.0.${i + 1}`));
		await keepWrong(4, (i) => claimMfaAttempt(RECOVERY(`challenge-${i + 10}`), IP));
		await expect(claimMfaAttempt(RECOVERY('challenge-1'), IP)).resolves.toHaveProperty('claim');
	});

	// Separates « an authenticator code is counted on the ACCOUNT » from « on the challenge »: every
	// correct password opens a new challenge, so a challenge key let whoever knew the password guess
	// without bound. The account's five wrong codes came on five challenges from five addresses.
	it('un code TOTP est compté par compte: un nouveau challenge ne remet pas le compteur à zéro', async () => {
		await keepWrong(5, (i) => claimMfaAttempt(TOTP('user-1'), `10.0.0.${i + 1}`));
		await expect(claimMfaAttempt(TOTP('user-1'), IP)).resolves.toEqual({
			trip: { counter: 'subject' }
		});
		await expect(claimMfaAttempt(TOTP('user-2'), IP)).resolves.toHaveProperty('claim');
	});

	// Separates « a recovery code is counted apart from the account's codes » from « on the
	// account », which whoever holds the password can keep full, locking the owner out of the way
	// back in (`claimMfaAttempt`).
	it("un code de récupération n'est pas compté sur le compteur du compte", async () => {
		await keepWrong(5, (i) => claimMfaAttempt(TOTP('user-1'), `10.0.0.${i + 1}`));
		await expect(claimMfaAttempt(RECOVERY('challenge-1'), IP)).resolves.toHaveProperty('claim');
	});

	// An authenticator code under 'MFA', a recovery code under 'MFA_RECOVERY': the kind is part of
	// every counter, so it is what keeps the two from sharing one.
	it.each([
		['un code TOTP', TOTP('user-1'), 'MFA'],
		['un code de récupération', RECOVERY('challenge-1'), 'MFA_RECOVERY']
	] as const)(
		'%s compte et écrit sous son propre kind, aux clés hachées',
		async (_label, code, kind) => {
			await claimMfaAttempt(code, IP);

			const kinds = db.prisma.loginAttempt.count.mock.calls.map((call) => call[0].where.kind);
			expect(kinds).toEqual([kind, kind, kind, kind]);
			expect(db.prisma.loginAttempt.create.mock.calls.map((call) => call[0].data)).toEqual([
				{
					kind,
					emailHash: expect.stringMatching(HEX_SHA256),
					ipHash: expect.stringMatching(HEX_SHA256)
				}
			]);
		}
	);

	// Separates « a recovery code has an address counter of its own » from « it shares the
	// authenticator codes' »: whoever holds the password fills the address counter from the owner's
	// own network with five wrong authenticator codes, and the recovery code must still be admitted
	// from there. The five are on five accounts so only the address counter is full.
	it('cinq codes TOTP faux depuis une adresse laissent un code de récupération admis depuis cette adresse', async () => {
		await keepWrong(5, (i) => claimMfaAttempt(TOTP(`user-${i + 1}`), IP));
		await expect(claimMfaAttempt(TOTP('user-9'), IP)).resolves.toEqual({
			trip: { counter: 'address' }
		});
		await expect(claimMfaAttempt(RECOVERY('challenge-1'), IP)).resolves.toHaveProperty('claim');
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

		await expect(isBankSyncStartRateLimited('user-1', '127.0.0.1')).resolves.toEqual({
			counter: 'subject'
		});
	});

	it('retourne true si >= 5 tentatives par IP, même sur des comptes différents', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count
			.mockResolvedValueOnce(0) // par userId
			.mockResolvedValueOnce(5); // par ip

		await expect(isBankSyncStartRateLimited('user-1', '127.0.0.1')).resolves.toEqual({
			counter: 'address'
		});
	});

	it("retourne false sous le seuil pour le userId et pour l'IP", async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(4).mockResolvedValueOnce(4);

		await expect(isBankSyncStartRateLimited('user-1', '127.0.0.1')).resolves.toBeNull();
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

	it('retourne true si >= 5 tentatives par session dans la fenêtre', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(5);

		await expect(isReauthRateLimited('session-1')).resolves.not.toBeNull();
	});

	it('retourne false sous le seuil pour la session', async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(4);

		await expect(isReauthRateLimited('session-1')).resolves.toBeNull();
	});

	// Separates « REAUTH counts by session only » from « REAUTH also counts by address »: the address
	// dimension was removed on purpose (another session's wrong passwords from the same address must
	// not lock the owner out), so a re-added ipHash count is a second call or an ipHash key here.
	it('compte une seule fois, par emailHash (la session), sans ipHash', async () => {
		expect.assertions(4);

		db.prisma.loginAttempt.count.mockResolvedValue(0);

		await isReauthRateLimited('session-1');

		expect(db.prisma.loginAttempt.count).toHaveBeenCalledTimes(1);
		const where = db.prisma.loginAttempt.count.mock.calls[0][0].where;
		expect(where.emailHash).toMatch(HEX_SHA256);
		expect(where).not.toHaveProperty('ipHash');
		expect(Object.keys(where).sort()).toEqual(['createdAt', 'emailHash', 'kind']);
	});

	it("filtre par kind: 'REAUTH', isolé des autres compteurs", async () => {
		expect.assertions(1);

		db.prisma.loginAttempt.count.mockResolvedValueOnce(0);

		await isReauthRateLimited('session-1');

		expect(db.prisma.loginAttempt.count.mock.calls[0][0].where.kind).toBe('REAUTH');
	});

	it('utilise une fenêtre de 5 minutes, plus courte que les 15 minutes du login', async () => {
		expect.assertions(1);

		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-02T12:00:00.000Z'));

		db.prisma.loginAttempt.count.mockResolvedValueOnce(0);
		await isReauthRateLimited('session-1');

		// The distinctive property of this kind: a 5-minute sliding window (not 15), so an honest
		// owner locked out by five wrong attempts recovers three times faster and the escape hatch
		// (deleteAccount) reopens quickly.
		const args = db.prisma.loginAttempt.count.mock.calls[0][0];
		expect(args.where.createdAt.gte).toEqual(new Date('2026-07-02T11:55:00.000Z'));
	});

	// Separates « refuses loudly » from « fails open ». REAUTH has no address to fall back on, so a
	// session id missing at run time (a cast the type cannot see) would leave no counter at all, and
	// an empty list of counts reads as « under the limit ».
	it('refuse un appel sans session au lieu de laisser passer', async () => {
		expect.assertions(2);

		await expect(isReauthRateLimited(undefined as unknown as string)).rejects.toThrow(
			'rate limiter called with no key for REAUTH'
		);
		expect(db.prisma.loginAttempt.count).not.toHaveBeenCalled();
	});

	it("recordReauthAttempt crée une ligne kind: 'REAUTH' avec session et IP hachées", async () => {
		expect.assertions(4);

		await recordReauthAttempt('session-1', '127.0.0.1');

		expect(db.prisma.loginAttempt.create).toHaveBeenCalledTimes(1);
		const createArgs = db.prisma.loginAttempt.create.mock.calls[0][0];
		expect(createArgs.data.kind).toBe('REAUTH');
		expect(createArgs.data.emailHash).toMatch(HEX_SHA256);
		expect(createArgs.data.ipHash).toMatch(HEX_SHA256);
	});
});

describe('assertRateLimitSecretConfigured', () => {
	// The 64-hex contract is stated at docs/getting-started.md:388 and produced by
	// `openssl rand -hex 32` at :66-67. Until this check existed, rateLimit.ts accepted any
	// non-empty string and fed it straight to createHmac as the key.
	it('refuses a secret that is too short', () => {
		expect(() => assertRateLimitSecretConfigured({ RATE_LIMIT_HASH_SECRET: 'abc123' })).toThrow(
			/64 hex characters/
		);
	});

	it('refuses a 64-character value that is not hex', () => {
		expect(() =>
			assertRateLimitSecretConfigured({ RATE_LIMIT_HASH_SECRET: 'z'.repeat(64) })
		).toThrow(/64 hex characters/);
	});

	it('refuses a missing secret and names the generation command', () => {
		expect(() => assertRateLimitSecretConfigured({})).toThrow(/openssl rand -hex 32/);
	});

	// The boundary, tested ON the boundary: 63 and 65 are the two values where a length
	// comparison and a range comparison would disagree.
	it.each([63, 65])('refuses %i hex characters', (length) => {
		expect(() =>
			assertRateLimitSecretConfigured({ RATE_LIMIT_HASH_SECRET: 'a'.repeat(length) })
		).toThrow(/64 hex characters/);
	});

	it('accepts exactly 64 hex characters in either case', () => {
		expect(() =>
			assertRateLimitSecretConfigured({ RATE_LIMIT_HASH_SECRET: 'A'.repeat(32) + 'f'.repeat(32) })
		).not.toThrow();
	});
});

/**
 * THE IMPORT DOORS.
 *
 * The reachable denial of service on `/import` is a LOOP: one upload is bounded and cheap, and
 * nothing stopped the second one. So this limiter is half of that fix rather than defence in depth
 * beside it.
 *
 * It carries its own maximum rather than sharing the authentication one, and the reason is a
 * product fact: five attempts per fifteen minutes is right for a password and wrong for statements,
 * because a household importing a year of monthly statements across three accounts uploads dozens
 * of files in one sitting. A limiter that refuses that has replaced a denial of service with a
 * denial of the product.
 */
describe('isImportRateLimited', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// Separates "the limiter trips at its own maximum" from "it trips at the authentication one",
	// which is the mistake that would lock an honest household out of its own statements.
	it('does not trip below its own maximum, which is above the authentication maximum', async () => {
		expect(IMPORT_DEFAULT_MAX_ATTEMPTS).toBeGreaterThan(5);
		db.prisma.loginAttempt.count.mockResolvedValue(IMPORT_DEFAULT_MAX_ATTEMPTS - 1);
		await expect(isImportRateLimited('user-1', '10.0.0.1')).resolves.toBeNull();
	});

	it('trips at its maximum', async () => {
		db.prisma.loginAttempt.count.mockResolvedValue(IMPORT_DEFAULT_MAX_ATTEMPTS);
		await expect(isImportRateLimited('user-1', '10.0.0.1')).resolves.toEqual({ counter: 'both' });
	});

	// Separates "keyed by both dimensions" from "keyed by one", which is what lets an attacker
	// rotate IPs on one account, or spray many accounts from one address.
	it('counts against the user AND the address', async () => {
		db.prisma.loginAttempt.count.mockResolvedValue(0);
		await isImportRateLimited('user-1', '10.0.0.1');
		expect(db.prisma.loginAttempt.count).toHaveBeenCalledTimes(2);
		const wheres = db.prisma.loginAttempt.count.mock.calls.map((call) => call[0].where);
		expect(wheres.every((where) => where.kind === 'IMPORT')).toBe(true);
		expect(wheres.some((where) => HEX_SHA256.test(where.emailHash ?? ''))).toBe(true);
		expect(wheres.some((where) => HEX_SHA256.test(where.ipHash ?? ''))).toBe(true);
	});

	// Separates "its own counter" from "shares the login counter", which would let failed logins
	// lock a user out of importing and vice versa.
	it('records under its own kind, so it shares no counter with authentication', async () => {
		await recordImportAttempt('user-1', '10.0.0.1');
		expect(db.prisma.loginAttempt.create).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ kind: 'IMPORT' }) })
		);
	});

	it('never stores the raw user id or address', async () => {
		await recordImportAttempt('user-1', '10.0.0.1');
		const data = db.prisma.loginAttempt.create.mock.calls[0][0].data;
		expect(data.emailHash).toMatch(HEX_SHA256);
		expect(data.ipHash).toMatch(HEX_SHA256);
		expect(JSON.stringify(data)).not.toContain('user-1');
		expect(JSON.stringify(data)).not.toContain('10.0.0.1');
	});
});

/**
 * THE IMPORT LIMIT IS READ FROM THE ENVIRONMENT (`IMPORT_RATE_LIMIT_MAX_ATTEMPTS`), with the shape
 * every other operator bound here has: a default, a hard ceiling, refusal rather than clamping, and
 * a boot warning on any departure. The e2e suite is the first consumer: it runs as one address and
 * its import specs alone spend 59 of the default 60.
 */
describe('the import limit is configurable, and the configuration cannot remove it', () => {
	function withEnv<T>(value: string | undefined, run: () => T): T {
		const previous = process.env[IMPORT_MAX_ATTEMPTS_ENV];
		if (value === undefined) delete process.env[IMPORT_MAX_ATTEMPTS_ENV];
		else process.env[IMPORT_MAX_ATTEMPTS_ENV] = value;
		try {
			return run();
		} finally {
			if (previous === undefined) delete process.env[IMPORT_MAX_ATTEMPTS_ENV];
			else process.env[IMPORT_MAX_ATTEMPTS_ENV] = previous;
		}
	}

	function captureEvents(run: () => void): unknown[] {
		logged.length = 0;
		run();
		return [...logged];
	}

	function refusalOf(value: string): string {
		try {
			withEnv(value, resolveImportMaxAttempts);
		} catch (caught) {
			return caught instanceof Error ? caught.message : String(caught);
		}
		throw new Error(`${IMPORT_MAX_ATTEMPTS_ENV}=${value} was accepted`);
	}

	beforeEach(() => {
		vi.clearAllMocks();
	});

	// Separates "unset means the shipped behaviour" from "unset means something else": every install
	// that sets nothing must keep exactly the limit it had before this variable existed.
	it('is OPTIONAL: an absent or blank value is the default of 60, never a refusal to start', () => {
		expect(withEnv(undefined, resolveImportMaxAttempts)).toBe(60);
		expect(withEnv('   ', resolveImportMaxAttempts)).toBe(IMPORT_DEFAULT_MAX_ATTEMPTS);
		expect(() => withEnv(undefined, assertImportRateLimitConfigured)).not.toThrow();
	});

	// Separates "the resolver reads the variable" from "the resolver ignores it and returns the
	// default", which would make every refusal below meaningless.
	it('honours a legal value', () => {
		expect(withEnv('180', resolveImportMaxAttempts)).toBe(180);
	});

	// Separates "the LIMITER consults the configured value" from "the resolver exists and the
	// limiter still reads the default". Every other test in this block calls the resolver directly,
	// so all of them pass on a limiter that never asks it. 60 is where the two disagree: the default
	// trips there, a configured 100 does not.
	it('the limiter trips at the configured value, not at the default', async () => {
		process.env[IMPORT_MAX_ATTEMPTS_ENV] = '100';
		try {
			db.prisma.loginAttempt.count.mockResolvedValue(IMPORT_DEFAULT_MAX_ATTEMPTS);
			await expect(isImportRateLimited('user-1', '10.0.0.1')).resolves.toBeNull();
			db.prisma.loginAttempt.count.mockResolvedValue(99);
			await expect(isImportRateLimited('user-1', '10.0.0.1')).resolves.toBeNull();
			db.prisma.loginAttempt.count.mockResolvedValue(100);
			await expect(isImportRateLimited('user-1', '10.0.0.1')).resolves.toEqual({ counter: 'both' });
		} finally {
			delete process.env[IMPORT_MAX_ATTEMPTS_ENV];
		}
	});

	// Separates "only IMPORT reads the variable" from "it leaks into the authentication limit",
	// which is out of scope and would hand a password grinder the import budget.
	it('does not move the login limit', async () => {
		process.env[IMPORT_MAX_ATTEMPTS_ENV] = '100';
		try {
			db.prisma.loginAttempt.count.mockResolvedValue(5);
			await expect(claimLoginAttempt('user@example.test', '127.0.0.1')).resolves.toEqual({
				trip: { counter: 'both' }
			});
		} finally {
			delete process.env[IMPORT_MAX_ATTEMPTS_ENV];
		}
	});

	// Separates "refused above the ceiling" from "clamped to the ceiling". Asserted on the REASON:
	// a clamp returns a perfectly reasonable number, and a refusal for the wrong reason (a malformed
	// value) would satisfy a bare toThrow. 240 and 241 are the two values where `>` and `>=`
	// disagree, and they are written as literals because the ceiling is a decision the table in
	// rateLimit.ts records: moving it is an edit to that table and to this test together.
	it('refuses a value above the hard ceiling instead of clamping it, naming the ceiling and the file', () => {
		expect(withEnv('240', resolveImportMaxAttempts)).toBe(240);
		expect(IMPORT_MAX_ATTEMPTS_CEILING).toBe(240);

		const refusal = refusalOf('241');
		expect(refusal).toContain(`${IMPORT_MAX_ATTEMPTS_ENV}=241`);
		expect(refusal).toContain('hard ceiling of 240');
		expect(refusal).toContain('refused rather than clamped');
		expect(refusal).toContain('src/lib/server/auth/rateLimit.ts');
	});

	// Separates "the boot check refuses" from "only the per-request read refuses", which would let
	// the app start and then throw on the first upload.
	it('refuses to boot above the ceiling', () => {
		expect(() => withEnv('100000', assertImportRateLimitConfigured)).toThrow('hard ceiling of 240');
	});

	// Separates "a malformed value is refused" from "it falls back to the default", which is the
	// silent shape #284 records for PASSWORD_HASH_COST and SESSION_TTL_DAYS.
	it.each(['0', '-1', '1.5', 'beaucoup', '60 per minute'])(
		'refuses %j as not a whole number',
		(bad) => {
			const refusal = refusalOf(bad);
			expect(refusal).toContain(`${IMPORT_MAX_ATTEMPTS_ENV} must be a whole number of at least 1`);
			expect(refusal).toContain(JSON.stringify(bad));
		}
	);

	// Presence control first: a logger that warned unconditionally would satisfy the rest, and an
	// operator who sees a warning on a default install stops reading warnings.
	it('says nothing at boot on the default', () => {
		expect(withEnv(undefined, () => captureEvents(assertImportRateLimitConfigured))).toEqual([]);
		expect(withEnv('60', () => captureEvents(assertImportRateLimitConfigured))).toEqual([]);
	});

	// Separates "a departure is announced" from "it is applied silently": the reader of the boot log
	// after an incident is usually not the person who changed the setting.
	it('names both values and the direction when the limit is raised', () => {
		const raised = withEnv('180', () => captureEvents(assertImportRateLimitConfigured));
		expect(raised).toEqual([
			{
				event: EVENT.configBoundChanged,
				attributes: {
					[ATTRIBUTE.configName]: IMPORT_MAX_ATTEMPTS_ENV,
					[ATTRIBUTE.configValue]: 180,
					[ATTRIBUTE.configDefault]: IMPORT_DEFAULT_MAX_ATTEMPTS,
					[ATTRIBUTE.configDirection]: 'raised',
					[ATTRIBUTE.configBelowHonestMinimum]: false
				}
			}
		]);
	});

	it('warns when the limit is lowered below an honest batch of statements', () => {
		expect(10).toBeLessThan(HONEST_IMPORT_BATCH_ATTEMPTS);
		const lowered = withEnv('10', () => captureEvents(assertImportRateLimitConfigured));
		expect(lowered).toEqual([
			{
				event: EVENT.configBoundChanged,
				attributes: {
					[ATTRIBUTE.configName]: IMPORT_MAX_ATTEMPTS_ENV,
					[ATTRIBUTE.configValue]: 10,
					[ATTRIBUTE.configDefault]: IMPORT_DEFAULT_MAX_ATTEMPTS,
					[ATTRIBUTE.configDirection]: 'lowered',
					[ATTRIBUTE.configBelowHonestMinimum]: true
				}
			}
		]);
	});

	// Between the honest batch and the default only the departure itself is reported, so
	// below_honest_minimum keeps meaning "files a household uploads will be refused".
	it('reports a departure between the honest batch and the default as not below the honest minimum', () => {
		expect(50).toBeGreaterThanOrEqual(HONEST_IMPORT_BATCH_ATTEMPTS);
		const trimmed = withEnv('50', () => captureEvents(assertImportRateLimitConfigured));
		expect(trimmed).toEqual([
			{
				event: EVENT.configBoundChanged,
				attributes: {
					[ATTRIBUTE.configName]: IMPORT_MAX_ATTEMPTS_ENV,
					[ATTRIBUTE.configValue]: 50,
					[ATTRIBUTE.configDefault]: IMPORT_DEFAULT_MAX_ATTEMPTS,
					[ATTRIBUTE.configDirection]: 'lowered',
					[ATTRIBUTE.configBelowHonestMinimum]: false
				}
			}
		]);
	});

	// WITHOUT THIS THE CEILING IS DECORATION. Every test above calls the module directly, so all of
	// them pass on a build where the boot collector never runs the check. Compared by FUNCTION
	// REFERENCE, which is what ENVIRONMENT_CHECKS is exported for.
	it('the boot check is registered with the boot collector', () => {
		const registered = ENVIRONMENT_CHECKS.filter(
			([, run]) => run === assertImportRateLimitConfigured
		);
		expect(registered).toHaveLength(1);
		// Calibration: the same comparison finds a check that is known to be registered.
		expect(ENVIRONMENT_CHECKS.some(([, run]) => run === assertRateLimitSecretConfigured)).toBe(
			true
		);
	});

	// Separates "the e2e configuration boots" from "it sits above the ceiling and the suite's server
	// refuses to start". Read through the SAME object Playwright hands the web server.
	it('the e2e configuration raises the limit, and to a value this module accepts', () => {
		const configured = E2E_ENV[IMPORT_MAX_ATTEMPTS_ENV];
		expect(configured).toBeDefined();
		const attempts = withEnv(configured, resolveImportMaxAttempts);
		expect(attempts).toBeGreaterThan(IMPORT_DEFAULT_MAX_ATTEMPTS);
	});
});

/**
 * WHICH COUNTER TRIPPED (L3 contract, amended). The authentication wrappers answer which counter
 * refused (`RateLimitTrip`; the two claims as `{ trip }`) so that the ROUTE can write the refusal's
 * event with the user and the counter; the limiter itself logs nothing. Counts are answered by the column queried, never by
 * call order, so a reordering of the two counts cannot swap which counter a test fills.
 */
describe('the authentication wrappers say which counter tripped, and log nothing (L3)', () => {
	const IP = '192.0.2.1';

	/** Fills the address counter, the subject counter, both or neither. */
	function fill({ address, subject }: { address: boolean; subject: boolean }) {
		db.prisma.loginAttempt.count.mockImplementation(async (args: { where: object }) => {
			const full = 'ipHash' in args.where ? address : subject;
			return full ? 1000 : 0;
		});
	}

	beforeEach(() => {
		vi.clearAllMocks();
		logged.length = 0;
		db.prisma.loginAttempt.create.mockResolvedValue({ id: 'row-1' });
	});
	afterEach(() => {
		db.prisma.loginAttempt.count.mockReset();
		db.prisma.loginAttempt.create.mockReset();
	});

	// The two kinds that count an address AND a subject, each through its own claim.
	const TWO_COUNTERS: [string, () => Promise<unknown>][] = [
		['LOGIN', () => claimLoginAttempt('user@example.test', IP)],
		['MFA', () => claimMfaAttempt({ factor: 'totp', userId: 'user-1' }, IP)]
	];

	it.each(TWO_COUNTERS)(
		'%s with only the address counter full answers address',
		async (_k, check) => {
			fill({ address: true, subject: false });
			await expect(check()).resolves.toEqual({ trip: { counter: 'address' } });
		}
	);

	it.each(TWO_COUNTERS)(
		'%s with only the subject counter full answers subject',
		async (_k, check) => {
			fill({ address: false, subject: true });
			await expect(check()).resolves.toEqual({ trip: { counter: 'subject' } });
		}
	);

	it.each(TWO_COUNTERS)('%s with both counters full answers both', async (_k, check) => {
		fill({ address: true, subject: true });
		await expect(check()).resolves.toEqual({ trip: { counter: 'both' } });
	});

	it.each(TWO_COUNTERS)('%s under both limits answers its claim', async (_k, check) => {
		fill({ address: false, subject: false });
		await expect(check()).resolves.toEqual({ claim: { id: 'row-1' } });
	});

	// REGISTER and INVITE count only the address; REAUTH only the session (#879).
	it.each([
		['REGISTER', 'address', () => isRegisterRateLimited(IP)],
		['INVITE', 'address', () => isInviteRateLimited(IP)],
		['REAUTH', 'subject', () => isReauthRateLimited('session-1')]
	] as const)('%s refused answers its one counter, %s', async (_kind, counter, check) => {
		fill({ address: true, subject: true });
		await expect(check()).resolves.toEqual({ counter });
	});

	it.each([
		['REGISTER', () => isRegisterRateLimited(IP)],
		['INVITE', () => isInviteRateLimited(IP)],
		['REAUTH', () => isReauthRateLimited('session-1')]
	])('%s under its limit answers null', async (_kind, check) => {
		fill({ address: false, subject: false });
		await expect(check()).resolves.toBeNull();
	});

	// The route writes the refusal's line; a second one here would be two events for one outcome.
	// `writes` proves the calls ran: five records, and two claims admitted and settled each way,
	// after seven checks refused (the two claims among them, refused before writing).
	it('the limiter module writes no log line on any check, claim, settle or record', async () => {
		fill({ address: true, subject: true });
		await claimLoginAttempt('user@example.test', IP);
		await claimMfaAttempt({ factor: 'totp', userId: 'user-1' }, IP);
		await isRegisterRateLimited(IP);
		await isInviteRateLimited(IP);
		await isReauthRateLimited('session-1');
		await isBankSyncStartRateLimited('user-1', IP);
		await isImportRateLimited('user-1', IP);
		fill({ address: false, subject: false });
		await settleAttempt(claimOf(await claimLoginAttempt('user@example.test', IP)), true);
		await settleAttempt(
			claimOf(await claimMfaAttempt({ factor: 'totp', userId: 'user-1' }, IP)),
			false
		);
		await recordRegisterAttempt(IP);
		await recordInviteAttempt(IP);
		await recordReauthAttempt('session-1', IP);
		await recordBankSyncStartAttempt('user-1', IP);
		await recordImportAttempt('user-1', IP);
		expect({ writes: db.prisma.loginAttempt.create.mock.calls.length, logged }).toEqual({
			writes: 7,
			logged: []
		});
	});
});

// #250 L4b: the route logs a work-kind refusal (decision above), so the limiter must hand it the
// counter that was full, as it does for the authentication kinds. A counter written as a constant
// fails two of the three rows; a wrapper still answering a boolean fails all of them.
describe('a refused import or bank-sync start names its counter and logs nothing itself', () => {
	const wrappers = {
		IMPORT: { refuse: isImportRateLimited, max: IMPORT_DEFAULT_MAX_ATTEMPTS },
		BANK_SYNC_START: { refuse: isBankSyncStartRateLimited, max: 5 }
	} as const;
	const counters = {
		subject: [true, false],
		address: [false, true],
		both: [true, true]
	} as const;

	beforeEach(() => {
		vi.clearAllMocks();
		logged.length = 0;
	});

	it.each(
		(Object.keys(wrappers) as (keyof typeof wrappers)[]).flatMap((kind) =>
			(Object.keys(counters) as (keyof typeof counters)[]).map(
				(counter) => [kind, counter] as const
			)
		)
	)('%s refused by the %s counter answers that counter', async (kind, counter) => {
		const { refuse, max } = wrappers[kind];
		const [subjectFull, addressFull] = counters[counter];
		// tripOf counts the subject (the user) first, then the address.
		db.prisma.loginAttempt.count
			.mockResolvedValueOnce(subjectFull ? max : 0)
			.mockResolvedValueOnce(addressFull ? max : 0);
		expect({ trip: await refuse('user-1', '10.0.0.1'), logged }).toEqual({
			trip: { counter },
			logged: []
		});
	});

	it.each(Object.keys(wrappers) as (keyof typeof wrappers)[])(
		'%s under its maximum answers null',
		async (kind) => {
			const { refuse, max } = wrappers[kind];
			db.prisma.loginAttempt.count.mockResolvedValue(max - 1);
			expect(await refuse('user-1', '10.0.0.1')).toBeNull();
		}
	);
});
