import { error } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
	createNetWorthAccount: vi.fn(),
	deleteNetWorthAccount: vi.fn(),
	getManualAccountNetWorthLink: vi.fn(),
	readNetWorthAccounts: vi.fn(),
	readNetWorthSeries: vi.fn(),
	setManualAccountNetWorthLink: vi.fn(),
	updateNetWorthAccount: vi.fn()
}));

const savingsGoalsService = vi.hoisted(() => ({
	readSavingsGoals: vi.fn(async () => []),
	readSavingsGoalHistory: vi.fn(async () => []),
	createSavingsGoal: vi.fn(),
	updateSavingsGoal: vi.fn(),
	deleteSavingsGoal: vi.fn(),
	dismissReachedBanner: vi.fn()
}));

vi.mock('$lib/server/net-worth/service', () => service);
vi.mock('$lib/server/savings-goals/service', () => savingsGoalsService);

// The L4a block runs the REAL savings-goal service against this table; nothing else reads it.
const dbFake = vi.hoisted(() => ({ prisma: {} as Record<string, unknown> }));
vi.mock('$lib/server/db', () => dbFake);

// The L4a block reads the authorization lines the real service writes.
vi.hoisted(() => {
	process.env.RATE_LIMIT_HASH_SECRET ??= 'a1'.repeat(32);
});
const logged = vi.hoisted(() => [] as unknown[]);
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: (event: unknown) => {
		logged.push(event);
	}
}));

const { load, actions } = await import('./+page.server');
const { deleteSavingsGoal: realDeleteSavingsGoal, createSavingsGoal: realCreateSavingsGoal } =
	await vi.importActual<typeof import('$lib/server/savings-goals/service')>(
		'$lib/server/savings-goals/service'
	);
const { ATTRIBUTE: A, EVENT: E } = await import('$lib/server/logging/names');
const { logUserPseudonym } = await import('$lib/server/logging/pseudonym');
const m = await import('$lib/paraglide/messages');
const testUser = { id: 'user-a', email: 'a@example.test', role: 'USER' as const };

function buildFormData(fields: Record<string, string>): FormData {
	const formData = new FormData();
	for (const [key, value] of Object.entries(fields)) formData.set(key, value);
	return formData;
}

function buildEvent(fields: Record<string, string>) {
	return {
		locals: { user: testUser },
		request: new Request('http://localhost/net-worth', {
			method: 'POST',
			body: buildFormData(fields)
		})
	};
}

describe('/net-worth load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renvoie manualAccountNetWorthAccountId reflétant le lien actuel', async () => {
		service.readNetWorthAccounts.mockResolvedValue([]);
		service.readNetWorthSeries.mockResolvedValue([]);
		service.getManualAccountNetWorthLink.mockResolvedValue('acc-linked');

		const result = (await load({ locals: { user: testUser } } as never)) as {
			manualAccountNetWorthAccountId: string | null;
		};

		expect(result.manualAccountNetWorthAccountId).toBe('acc-linked');
		expect(service.getManualAccountNetWorthLink).toHaveBeenCalledWith(testUser.id);
	});

	it('exclut les comptes de type debt de linkableAccounts (le Combobox ne doit jamais proposer une option que le serveur rejette)', async () => {
		service.readNetWorthAccounts.mockResolvedValue([
			{
				id: 'acc-checking',
				name: 'Compte courant',
				type: 'checking',
				balanceCents: 100,
				connected: false
			},
			{ id: 'acc-debt', name: 'Crédit auto', type: 'debt', balanceCents: 5000, connected: false },
			{
				id: 'acc-house',
				name: 'Maison',
				type: 'real_estate',
				balanceCents: 200000,
				connected: false
			}
		]);
		service.readNetWorthSeries.mockResolvedValue([]);
		service.getManualAccountNetWorthLink.mockResolvedValue(null);

		const result = (await load({ locals: { user: testUser } } as never)) as {
			linkableAccounts: Array<{ id: string; type: string }>;
		};

		expect(result.linkableAccounts.map((a) => a.id)).toEqual(['acc-checking']);
	});

	it('renvoie null si jamais lié', async () => {
		service.readNetWorthAccounts.mockResolvedValue([]);
		service.readNetWorthSeries.mockResolvedValue([]);
		service.getManualAccountNetWorthLink.mockResolvedValue(null);

		const result = (await load({ locals: { user: testUser } } as never)) as {
			manualAccountNetWorthAccountId: string | null;
		};

		expect(result.manualAccountNetWorthAccountId).toBeNull();
	});
});

describe('/net-worth create action', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('lie le compte manuel quand connectToTransactions=true et le type est linkable', async () => {
		service.createNetWorthAccount.mockResolvedValue({ id: 'acc-new' });

		await actions.create(
			buildEvent({
				name: 'Compte courant',
				type: 'checking',
				balance: '100',
				connectToTransactions: 'true'
			}) as never
		);

		expect(service.setManualAccountNetWorthLink).toHaveBeenCalledWith(testUser.id, 'acc-new');
	});

	it('ignore côté serveur une tentative de contournement (type non linkable + connectToTransactions=true)', async () => {
		service.createNetWorthAccount.mockResolvedValue({ id: 'acc-new' });

		await actions.create(
			buildEvent({
				name: 'Maison',
				type: 'real_estate',
				balance: '100000',
				connectToTransactions: 'true'
			}) as never
		);

		expect(service.setManualAccountNetWorthLink).not.toHaveBeenCalled();
	});

	it('ne lie rien quand connectToTransactions est absent', async () => {
		service.createNetWorthAccount.mockResolvedValue({ id: 'acc-new' });

		await actions.create(
			buildEvent({ name: 'Livret A', type: 'savings', balance: '500' }) as never
		);

		expect(service.setManualAccountNetWorthLink).not.toHaveBeenCalled();
	});

	it('échoue sans appeler setManualAccountNetWorthLink si la création échoue', async () => {
		service.createNetWorthAccount.mockRejectedValue(
			Object.assign(new Error('boom'), { status: 400, body: { message: 'invalide' } })
		);

		await actions.create(
			buildEvent({
				name: 'X',
				type: 'checking',
				balance: 'abc',
				connectToTransactions: 'true'
			}) as never
		);

		expect(service.setManualAccountNetWorthLink).not.toHaveBeenCalled();
	});
});

describe('/net-worth update action', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('lie le compte manuel quand connectToTransactions=true et le type est linkable', async () => {
		service.updateNetWorthAccount.mockResolvedValue(undefined);
		service.getManualAccountNetWorthLink.mockResolvedValue(null);

		await actions.update(
			buildEvent({
				id: 'acc-1',
				name: 'Compte courant',
				type: 'checking',
				balance: '100',
				connectToTransactions: 'true'
			}) as never
		);

		expect(service.setManualAccountNetWorthLink).toHaveBeenCalledWith(testUser.id, 'acc-1');
	});

	it('délie uniquement si le compte manuel était lié à CE compte', async () => {
		service.updateNetWorthAccount.mockResolvedValue(undefined);
		service.getManualAccountNetWorthLink.mockResolvedValue('acc-1');

		await actions.update(
			buildEvent({
				id: 'acc-1',
				name: 'Compte courant',
				type: 'checking',
				balance: '100'
			}) as never
		);

		expect(service.setManualAccountNetWorthLink).toHaveBeenCalledWith(testUser.id, null);
	});

	it('ne touche pas un lien existant vers un AUTRE compte quand connectToTransactions est désactivé', async () => {
		service.updateNetWorthAccount.mockResolvedValue(undefined);
		service.getManualAccountNetWorthLink.mockResolvedValue('acc-other');

		await actions.update(
			buildEvent({
				id: 'acc-1',
				name: 'Compte courant',
				type: 'checking',
				balance: '100'
			}) as never
		);

		expect(service.setManualAccountNetWorthLink).not.toHaveBeenCalled();
	});

	it('ignore côté serveur une tentative de contournement (type non linkable + connectToTransactions=true)', async () => {
		service.updateNetWorthAccount.mockResolvedValue(undefined);
		service.getManualAccountNetWorthLink.mockResolvedValue(null);

		await actions.update(
			buildEvent({
				id: 'acc-1',
				name: 'Maison',
				type: 'real_estate',
				balance: '100000',
				connectToTransactions: 'true'
			}) as never
		);

		expect(service.setManualAccountNetWorthLink).not.toHaveBeenCalled();
	});

	it('échoue sans toucher au lien si la mise à jour du compte échoue', async () => {
		service.updateNetWorthAccount.mockRejectedValue(
			Object.assign(new Error('boom'), { status: 404, body: { message: 'introuvable' } })
		);

		await actions.update(
			buildEvent({
				id: 'acc-1',
				name: 'X',
				type: 'checking',
				balance: '100',
				connectToTransactions: 'true'
			}) as never
		);

		expect(service.getManualAccountNetWorthLink).not.toHaveBeenCalled();
		expect(service.setManualAccountNetWorthLink).not.toHaveBeenCalled();
	});
});

describe('/net-worth load (savings goals)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		service.readNetWorthAccounts.mockResolvedValue([]);
		service.readNetWorthSeries.mockResolvedValue([]);
		service.getManualAccountNetWorthLink.mockResolvedValue(null);
	});

	it('attache un historique uniquement aux goals liés à un compte', async () => {
		savingsGoalsService.readSavingsGoals.mockResolvedValue([
			{ id: 'goal-linked', linkedAccount: { id: 'acc-1', name: 'Livret A' } },
			{ id: 'goal-manual', linkedAccount: null }
		] as never);
		savingsGoalsService.readSavingsGoalHistory.mockResolvedValue([
			{ capturedAt: '2026-01-01T00:00:00.000Z', balanceCents: 1000 }
		] as never);

		const result = (await load({ locals: { user: testUser } } as never)) as {
			savingsGoals: Array<{ id: string; history: unknown[] }>;
		};

		expect(savingsGoalsService.readSavingsGoalHistory).toHaveBeenCalledTimes(1);
		expect(savingsGoalsService.readSavingsGoalHistory).toHaveBeenCalledWith(
			testUser.id,
			'goal-linked'
		);
		expect(result.savingsGoals.find((g) => g.id === 'goal-linked')?.history).toHaveLength(1);
		expect(result.savingsGoals.find((g) => g.id === 'goal-manual')?.history).toEqual([]);
	});

	it("conserve l'historique d'un goal dont le lien est devenu stale (linkStale), pas seulement les goals encore liés", async () => {
		savingsGoalsService.readSavingsGoals.mockResolvedValue([
			{ id: 'goal-stale', linkedAccount: null, linkStale: true }
		] as never);
		savingsGoalsService.readSavingsGoalHistory.mockResolvedValue([
			{ capturedAt: '2026-01-01T00:00:00.000Z', balanceCents: 1000 }
		] as never);

		const result = (await load({ locals: { user: testUser } } as never)) as {
			savingsGoals: Array<{ id: string; history: unknown[] }>;
		};

		expect(savingsGoalsService.readSavingsGoalHistory).toHaveBeenCalledWith(
			testUser.id,
			'goal-stale'
		);
		expect(result.savingsGoals.find((g) => g.id === 'goal-stale')?.history).toHaveLength(1);
	});
});

describe('/net-worth createSavingsGoal action', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('transmet les champs du formulaire au service, scopé par userId', async () => {
		savingsGoalsService.createSavingsGoal.mockResolvedValue({ id: 'goal-new' });

		await actions.createSavingsGoal(
			buildEvent({
				name: 'Vacances',
				targetAmount: '1000',
				trackingMode: 'manual',
				currentAmount: '250',
				targetDate: '2027-01-01'
			}) as never
		);

		expect(savingsGoalsService.createSavingsGoal).toHaveBeenCalledWith(testUser.id, {
			name: 'Vacances',
			targetAmount: '1000',
			trackingMode: 'manual',
			netWorthAccountId: undefined,
			currentAmount: '250',
			targetDate: '2027-01-01'
		});
	});

	it('traduit une erreur du service en réponse fail()', async () => {
		savingsGoalsService.createSavingsGoal.mockImplementation(() => {
			throw error(400, 'invalide');
		});

		const result = (await actions.createSavingsGoal(
			buildEvent({ name: 'X', targetAmount: 'abc', trackingMode: 'manual' }) as never
		)) as { status: number; data: { error: string } };

		expect(result.status).toBe(400);
		expect(result.data.error).toBe('invalide');
	});
});

describe('/net-worth updateSavingsGoal action', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('transmet id + champs du formulaire au service, scopé par userId', async () => {
		savingsGoalsService.updateSavingsGoal.mockResolvedValue(undefined);

		await actions.updateSavingsGoal(
			buildEvent({
				id: 'goal-1',
				name: 'Vacances 2',
				targetAmount: '2000',
				trackingMode: 'linked',
				netWorthAccountId: 'acc-1'
			}) as never
		);

		expect(savingsGoalsService.updateSavingsGoal).toHaveBeenCalledWith(testUser.id, 'goal-1', {
			name: 'Vacances 2',
			targetAmount: '2000',
			trackingMode: 'linked',
			netWorthAccountId: 'acc-1',
			currentAmount: undefined,
			targetDate: undefined
		});
	});

	it('traduit une erreur 404 du service en réponse fail()', async () => {
		savingsGoalsService.updateSavingsGoal.mockImplementation(() => {
			throw error(404, 'introuvable');
		});

		const result = (await actions.updateSavingsGoal(
			buildEvent({
				id: 'goal-other-user',
				name: 'X',
				targetAmount: '1000',
				trackingMode: 'manual'
			}) as never
		)) as { status: number; data: { error: string } };

		expect(result.status).toBe(404);
		expect(result.data.error).toBe('introuvable');
	});
});

describe('/net-worth deleteSavingsGoal action', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("appelle le service avec l'id du formulaire, scopé par userId", async () => {
		savingsGoalsService.deleteSavingsGoal.mockResolvedValue(undefined);

		await actions.deleteSavingsGoal(buildEvent({ id: 'goal-1' }) as never);

		expect(savingsGoalsService.deleteSavingsGoal).toHaveBeenCalledWith(testUser.id, 'goal-1');
	});

	it('traduit une erreur du service en réponse fail()', async () => {
		savingsGoalsService.deleteSavingsGoal.mockImplementation(() => {
			throw error(404, 'introuvable');
		});

		const result = (await actions.deleteSavingsGoal(
			buildEvent({ id: 'goal-other-user' }) as never
		)) as {
			status: number;
			data: { error: string };
		};

		expect(result.status).toBe(404);
		expect(result.data.error).toBe('introuvable');
	});
});

describe('/net-worth dismissSavingsGoalReachedBanner action', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("appelle le service avec l'id du formulaire, scopé par userId", async () => {
		savingsGoalsService.dismissReachedBanner.mockResolvedValue(undefined);

		const result = (await actions.dismissSavingsGoalReachedBanner(
			buildEvent({ id: 'goal-1' }) as never
		)) as { success: boolean };

		expect(savingsGoalsService.dismissReachedBanner).toHaveBeenCalledWith(testUser.id, 'goal-1');
		expect(result.success).toBe(true);
	});

	it('traduit une erreur du service en réponse fail() (ex: banner non dismissible avant reachedAt)', async () => {
		savingsGoalsService.dismissReachedBanner.mockImplementation(() => {
			throw error(404, 'introuvable');
		});

		const result = (await actions.dismissSavingsGoalReachedBanner(
			buildEvent({ id: 'goal-not-reached' }) as never
		)) as { status: number; data: { error: string } };

		expect(result.status).toBe(404);
		expect(result.data.error).toBe('introuvable');
	});
});

/**
 * L4a: a malformed goal id (`!normalizeId`) is the same event as a missing one, indistinguishable by
 * construction (contract « When »). These run the REAL `deleteSavingsGoal`, the service that throws
 * `error(404)`, against a table scoped by the row's own userId.
 */
describe('L4a: a refused savings goal delete writes one authz_fail line, malformed or missing', () => {
	type Line = { event: string; attributes: Record<string, unknown> };
	const authzFails = () => (logged as Line[]).filter((line) => line.event === E.authzFail);
	const goals = [
		{ id: 'goal-owned', userId: 'user-a' },
		{ id: 'goal-foreign', userId: 'user-b' }
	];

	beforeEach(() => {
		vi.clearAllMocks();
		logged.length = 0;
		savingsGoalsService.deleteSavingsGoal.mockImplementation(realDeleteSavingsGoal);
		// Models the one predicate the soft delete issues, and THROWS on any other.
		dbFake.prisma.savingsGoal = {
			updateMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
				const keys = Object.keys(where).sort().join(',');
				if (keys !== 'deletedAt,id,userId' || where.deletedAt !== null) {
					throw new Error(`L4a savings goal fake: unsupported where ${keys}`);
				}
				const found = goals.some((row) => row.id === where.id && row.userId === where.userId);
				return { count: found ? 1 : 0 };
			})
		};
	});

	afterEach(() => {
		savingsGoalsService.deleteSavingsGoal.mockReset();
		delete dbFake.prisma.savingsGoal;
	});

	async function deleteGoal(id: string) {
		const result = (await actions.deleteSavingsGoal(buildEvent({ id }) as never)) as {
			status?: number;
			data?: unknown;
		};
		return { status: result.status, data: result.data, lines: authzFails() };
	}

	const refusedGoal = {
		status: 404,
		data: { error: m.savings_goal_error_not_found() },
		lines: [
			{
				event: E.authzFail,
				attributes: {
					[A.userPseudonym]: logUserPseudonym(testUser.id),
					[A.authzReason]: 'not_found_or_not_owned',
					[A.authzReference]: 'savings_goal'
				}
			}
		]
	};

	// Separates « the malformed path logs the same event » from « refused before any line » (today:
	// the `!normalizeId` branch throws first and no lookup ever runs).
	it('delete with a malformed goal id: one authz_fail savings_goal, and the same 404', async () => {
		expect(await deleteGoal('!!')).toEqual(refusedGoal);
	});

	it('delete with a goal id that does not exist: the same line and the same 404', async () => {
		expect(await deleteGoal('goal-missing')).toEqual(refusedGoal);
	});

	it('delete with a foreign goal id: the same line and the same 404', async () => {
		expect(await deleteGoal('goal-foreign')).toEqual(refusedGoal);
	});

	// The account picker is a combobox with no native `required`, so « linked » submitted with no
	// account sends no id at all. Separates « no reference sent, no line » from « a line for an id
	// nobody posted » (code contradiction pass on L4a); a malformed id still gets the line.
	it('create linked with no account sent writes no authz_fail; a malformed one writes the line', async () => {
		savingsGoalsService.createSavingsGoal.mockImplementation(realCreateSavingsGoal);
		const fields = { name: 'Vacances', targetAmount: '1000', trackingMode: 'linked' };
		const absent = (await actions.createSavingsGoal(buildEvent(fields) as never)) as {
			status?: number;
		};
		const absentLines = authzFails().length;
		const malformed = (await actions.createSavingsGoal(
			buildEvent({ ...fields, netWorthAccountId: '!!' }) as never
		)) as { status?: number };
		expect({
			absent: absent.status,
			absentLines,
			malformed: malformed.status,
			malformedLines: authzFails().map((line) => line.attributes[A.authzReference])
		}).toEqual({
			absent: 400,
			absentLines: 0,
			malformed: 400,
			malformedLines: ['net_worth_account']
		});
		savingsGoalsService.createSavingsGoal.mockReset();
	});

	// Negative: green today. Red if the call moves above the count check (logs every delete).
	it('delete with an owned goal id writes no authz_fail', async () => {
		const result = await actions.deleteSavingsGoal(buildEvent({ id: 'goal-owned' }) as never);
		expect({ result, lines: authzFails() }).toEqual({
			result: { success: m.savings_goal_success_deleted() },
			lines: []
		});
	});
});

/**
 * The two soft deletes write `sensitive_delete` (L4b-2, owner ruling 7, 2026-10-28): the member
 * pressed Delete and has no undo, so the row kept under `deletedAt` is still a deletion from their
 * side. Separates « written once the service returned » from « written before or whatever it
 * answers »: a service that refuses writes none.
 */
describe('/net-worth soft deletes write sensitive_delete', () => {
	const deletes = () =>
		logged.filter((line) => (line as { event: string }).event === E.sensitiveDelete);
	const line = (operation: string, scope: string) => ({
		event: E.sensitiveDelete,
		attributes: {
			[A.userPseudonym]: logUserPseudonym(testUser.id),
			[A.dataOperation]: operation,
			[A.dataScope]: scope
		}
	});

	beforeEach(() => {
		vi.clearAllMocks();
		logged.length = 0;
	});

	it('delete: one line, scope net_worth_account', async () => {
		service.deleteNetWorthAccount.mockResolvedValue(undefined);
		await actions.delete(buildEvent({ id: 'acc-1' }) as never);
		expect(deletes()).toEqual([line('delete_net_worth_account', 'net_worth_account')]);
	});

	it('delete refused by the service writes none', async () => {
		service.deleteNetWorthAccount.mockImplementation(() => {
			throw error(404, 'introuvable');
		});
		await actions.delete(buildEvent({ id: 'acc-other-user' }) as never);
		expect(deletes()).toEqual([]);
	});

	it('deleteSavingsGoal: one line, scope savings_goal', async () => {
		savingsGoalsService.deleteSavingsGoal.mockResolvedValue(undefined);
		await actions.deleteSavingsGoal(buildEvent({ id: 'goal-1' }) as never);
		expect(deletes()).toEqual([line('delete_savings_goal', 'savings_goal')]);
	});

	it('deleteSavingsGoal refused by the service writes none', async () => {
		savingsGoalsService.deleteSavingsGoal.mockImplementation(() => {
			throw error(404, 'introuvable');
		});
		await actions.deleteSavingsGoal(buildEvent({ id: 'goal-other-user' }) as never);
		expect(deletes()).toEqual([]);
	});
});

/**
 * #1087 piece 2: a created net worth account and a created savings goal write `sensitive_create`
 * right after the creating call returns. For an account the line comes BEFORE the optional link to
 * the transactions account, so a link that fails cannot hide a row already stored. Wire names as
 * literals.
 */
describe('#1087: create and createSavingsGoal write sensitive_create', () => {
	type Line = { event: string; attributes: Record<string, unknown> };
	const creates = () => (logged as Line[]).filter((line) => line.event === 'sensitive_create');
	const line = (operation: string, scope: string) => ({
		event: 'sensitive_create',
		attributes: {
			'budgetpilot.user.pseudonym': logUserPseudonym(testUser.id),
			'budgetpilot.data.operation': operation,
			'budgetpilot.data.scope': scope
		}
	});

	beforeEach(() => {
		vi.clearAllMocks();
		logged.length = 0;
		service.createNetWorthAccount.mockReset();
		service.setManualAccountNetWorthLink.mockReset();
		savingsGoalsService.createSavingsGoal.mockReset();
	});

	// Separates "the route logs a created account" from "the route writes nothing on create".
	it('create: one line, operation create_net_worth_account', async () => {
		service.createNetWorthAccount.mockResolvedValue({ id: 'acc-new' });
		await actions.create(
			buildEvent({ name: 'Livret A', type: 'savings', balance: '500' }) as never
		);
		expect(creates()).toEqual([line('create_net_worth_account', 'net_worth_account')]);
	});

	// Separates "line after the create" from "line at the end of the action": the account is stored
	// when the link throws, and the action answers a failure.
	it('create whose link fails after the account was stored: the line is still written', async () => {
		service.createNetWorthAccount.mockResolvedValue({ id: 'acc-new' });
		service.setManualAccountNetWorthLink.mockImplementation(() => {
			throw error(500, 'link failed');
		});
		await actions.create(
			buildEvent({
				name: 'Compte courant',
				type: 'checking',
				balance: '100',
				connectToTransactions: 'true'
			}) as never
		);
		expect(creates()).toEqual([line('create_net_worth_account', 'net_worth_account')]);
	});

	// Green today; separates "line after the create returned" from "line before the call".
	it('create refused by the service writes none', async () => {
		service.createNetWorthAccount.mockImplementation(() => {
			throw error(400, 'invalide');
		});
		const result = (await actions.create(
			buildEvent({ name: 'X', type: 'checking', balance: 'abc' }) as never
		)) as { status: number };
		expect({ status: result.status, lines: creates() }).toEqual({ status: 400, lines: [] });
	});

	// Separates "the route logs a created goal" from "the route writes nothing on createSavingsGoal".
	it('createSavingsGoal: one line, operation create_savings_goal', async () => {
		savingsGoalsService.createSavingsGoal.mockResolvedValue({ id: 'goal-new' });
		await actions.createSavingsGoal(
			buildEvent({ name: 'Vacances', targetAmount: '1000', trackingMode: 'manual' }) as never
		);
		expect(creates()).toEqual([line('create_savings_goal', 'savings_goal')]);
	});

	// Green today; separates "line after the create returned" from "line before the call".
	it('createSavingsGoal refused by the service writes none', async () => {
		savingsGoalsService.createSavingsGoal.mockImplementation(() => {
			throw error(400, 'invalide');
		});
		const result = (await actions.createSavingsGoal(
			buildEvent({ name: 'X', targetAmount: 'abc', trackingMode: 'manual' }) as never
		)) as { status: number };
		expect({ status: result.status, lines: creates() }).toEqual({ status: 400, lines: [] });
	});
});
