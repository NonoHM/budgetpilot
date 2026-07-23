import { error } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { load, actions } = await import('./+page.server');
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
