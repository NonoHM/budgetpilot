import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	prisma: {
		category: {
			findMany: vi.fn(async () => [
				{ name: 'Alimentation', defaultKey: 'food' },
				{ name: 'Maison', defaultKey: null }
			])
		}
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const budgetService = vi.hoisted(() => ({
	readMonthlyBudgets: vi.fn(async () => [
		{
			id: 'budget-a',
			categoryName: 'Alimentation',
			amountCents: 25_000,
			createdAt: '2026-06-01T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z'
		}
	]),
	readBudgetCategoryOptions: vi.fn(async () => ['Alimentation', 'Maison']),
	readCurrentMonthSpending: vi.fn(async () => new Map([['Alimentation', 12_000]])),
	getCurrentMonth: vi.fn(() => '2026-06'),
	saveBudget: vi.fn(async () => undefined),
	updateBudget: vi.fn(async () => undefined),
	deleteBudget: vi.fn(async () => undefined)
}));

vi.mock('$lib/server/budget/dashboard', () => budgetService);

const { actions, load } = await import('./+page.server');
const testUser = { id: 'user-a', email: 'a@example.test', role: 'USER' as const };

describe('/budgets', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('charge les budgets et les categories de l utilisateur courant', async () => {
		expect.assertions(7);

		const data = (await load({
			locals: { user: testUser }
		} as Parameters<typeof load>[0])) as Awaited<ReturnType<typeof load>> & {
			budgets: Array<{ amountEuros: string; spentCents: number }>;
			categoryOptions: string[];
			categories: Array<{ name: string; defaultKey: string | null }>;
			currentMonth: string;
		};

		expect(budgetService.readMonthlyBudgets).toHaveBeenCalledWith(testUser.id);
		expect(budgetService.readBudgetCategoryOptions).toHaveBeenCalledWith(testUser.id);
		expect(budgetService.readCurrentMonthSpending).toHaveBeenCalledWith(testUser.id);
		expect(data.budgets[0].amountEuros).toBe('250,00');
		expect(data.budgets[0].spentCents).toBe(12_000);
		expect(data.categoryOptions).toEqual(['Alimentation', 'Maison']);
		expect(data.categories).toEqual([
			{ name: 'Alimentation', defaultKey: 'food' },
			{ name: 'Maison', defaultKey: null }
		]);
	});

	it('cree un budget avec le userId serveur', async () => {
		expect.assertions(1);

		await runAction('create', { category: 'Alimentation', amount: '250' });

		expect(budgetService.saveBudget).toHaveBeenCalledWith(testUser.id, {
			category: 'Alimentation',
			limit: '250'
		});
	});

	it('met a jour un budget avec le userId serveur', async () => {
		expect.assertions(1);

		await runAction('update', { id: 'budget-a', category: 'Maison', amount: '300' });

		expect(budgetService.updateBudget).toHaveBeenCalledWith(testUser.id, 'budget-a', {
			category: 'Maison',
			limit: '300'
		});
	});

	it('supprime un budget avec le userId serveur', async () => {
		expect.assertions(1);

		await runAction('delete', { id: 'budget-a' });

		expect(budgetService.deleteBudget).toHaveBeenCalledWith(testUser.id, 'budget-a');
	});
});

async function runAction(name: keyof typeof actions, input: Record<string, string>) {
	const formData = new FormData();
	for (const [key, value] of Object.entries(input)) formData.set(key, value);

	return (await (
		actions[name] as (event: {
			locals: { user: typeof testUser };
			request: Request;
		}) => Promise<unknown>
	)({
		locals: { user: testUser },
		request: new Request('http://localhost/budgets', { method: 'POST', body: formData })
	})) as { status?: number; success?: string };
}
