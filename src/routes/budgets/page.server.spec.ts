import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CategorySpending } from '$lib/server/budget/dashboard';

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

// The L4a block reads the authorization lines the route and the real service write.
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

const { spentCentsFor: realSpentCentsFor, deleteBudget: realDeleteBudget } = await vi.importActual<
	typeof import('$lib/server/budget/dashboard')
>('$lib/server/budget/dashboard');

const budgetService = vi.hoisted(() => ({
	readMonthlyBudgets: vi.fn(async () => [
		{
			id: 'budget-a',
			// The spelling a budget is CREATED with, which `upsertBudgetByFoldedName` never rewrites.
			categoryName: 'Alimentation',
			amountCents: 25_000,
			createdAt: '2026-06-01T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z'
		}
	]),
	readBudgetCategoryOptions: vi.fn(async () => ['Alimentation', 'Maison']),
	/**
	 * FOLDED keys, because that is what the real `readCurrentMonthSpending` returns.
	 *
	 * This fixture used to read `new Map([['Alimentation', 12_000]])` — byte-identical to the
	 * budget's own `categoryName` — which baked the raw-name assumption into the test and made the
	 * defect structurally invisible: the `.get(budget.categoryName)` lookup could not miss. On the
	 * real map it missed for every category a user had spelled differently anywhere, which is how
	 * /budgets came to print 70,00 € against the dashboard's 74,50 € for the same budget.
	 */
	readCurrentMonthSpending: vi.fn(async () => new Map([['alimentation', 12_000]])),
	getCurrentMonth: vi.fn(() => '2026-06'),
	saveBudget: vi.fn(async () => undefined),
	updateBudget: vi.fn(async () => undefined),
	deleteBudget: vi.fn(async () => undefined),
	// The REAL folding helper, not a stand-in. A hand-written fake here would be a second copy of
	// the fold, and the copy is what the whole defect was made of.
	spentCentsFor: vi.fn((spending: ReadonlyMap<string, number>, categoryName: string) =>
		realSpentCentsFor(spending as CategorySpending, categoryName)
	)
}));

vi.mock('$lib/server/budget/dashboard', () => budgetService);

const { actions, load } = await import('./+page.server');
const { ATTRIBUTE: A, EVENT: E } = await import('$lib/server/logging/names');
const { logUserPseudonym } = await import('$lib/server/logging/pseudonym');
const m = await import('$lib/paraglide/messages');
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
		// The budget is spelled "Alimentation" and the spending map is keyed "alimentation". A raw
		// `spending.get(budget.categoryName)` answers 0 here — the shape that printed 0,00 € on
		// /budgets for a category the dashboard was reporting 27,00 € of spend for.
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

/**
 * L4a: the service that throws `error(404)` is where the refusal is decided, so these tests run the
 * REAL `deleteBudget` against a fake table scoped by userId, rather than the mock the rest of this
 * file uses. One `authz_fail` line naming the budget, and the answer is the 404 the route returned
 * before L4a (contract invariant 1).
 */
describe('L4a: a refused budget delete writes one authz_fail line', () => {
	type Line = { event: string; attributes: Record<string, unknown> };
	const authzFails = () => (logged as Line[]).filter((line) => line.event === E.authzFail);
	const budgets = [
		{ id: 'budget-a', userId: 'user-a' },
		{ id: 'budget-foreign', userId: 'user-b' }
	];
	const table = db.prisma as unknown as Record<string, unknown>;

	beforeEach(() => {
		vi.clearAllMocks();
		logged.length = 0;
		// The hoisted mock is typed zero-arity; the real service takes (userId, budgetId).
		budgetService.deleteBudget.mockImplementation(realDeleteBudget as never);
		// Scoped by the row's own userId, and THROWING on any other predicate.
		table.monthlyBudget = {
			deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
				const keys = Object.keys(where).sort().join(',');
				if (keys !== 'id,userId') throw new Error(`L4a budget fake: unsupported where ${keys}`);
				const found = budgets.some((row) => row.id === where.id && row.userId === where.userId);
				return { count: found ? 1 : 0 };
			})
		};
	});

	afterEach(() => {
		budgetService.deleteBudget.mockReset();
		budgetService.deleteBudget.mockImplementation(async () => undefined);
		delete table.monthlyBudget;
	});

	const refusedBudget = () => [
		{
			event: E.authzFail,
			attributes: {
				[A.userPseudonym]: logUserPseudonym(testUser.id),
				[A.authzReason]: 'not_found_or_not_owned',
				[A.authzReference]: 'budget'
			}
		}
	];

	// Separates « logged as a refused budget » from « refused silently » (today).
	it('delete on a foreign budget id: one authz_fail budget, and the same 404', async () => {
		const result = (await runAction('delete', { id: 'budget-foreign' })) as {
			status?: number;
			data?: unknown;
		};
		expect({ status: result.status, data: result.data, lines: authzFails() }).toEqual({
			status: 404,
			data: { error: m.budgets_error_not_found() },
			lines: refusedBudget()
		});
	});

	it('delete on a budget id that does not exist: the same line and the same 404', async () => {
		const result = (await runAction('delete', { id: 'budget-missing' })) as {
			status?: number;
			data?: unknown;
		};
		expect({ status: result.status, data: result.data, lines: authzFails() }).toEqual({
			status: 404,
			data: { error: m.budgets_error_not_found() },
			lines: refusedBudget()
		});
	});

	// Negative: green today. The log mirrors the answer (contract « When »): a malformed id refused
	// by the shape check with an answer of its own (400, the misworded `invalid_amount`, #1044) is
	// input validation and writes nothing here. Red if the shape-check branch logs.
	it('delete on a malformed budget id: the 400 it answered before, and no authz_fail', async () => {
		const result = (await runAction('delete', { id: 'bad!' })) as {
			status?: number;
			data?: unknown;
		};
		expect({ status: result.status, data: result.data, lines: authzFails() }).toEqual({
			status: 400,
			data: { error: m.budgets_error_invalid_amount() },
			lines: []
		});
	});

	// Negative: green today. Red if the call moves above the count check (logs every delete).
	it('delete on an owned budget writes no authz_fail', async () => {
		const result = await runAction('delete', { id: 'budget-a' });
		expect({ result, lines: authzFails() }).toEqual({
			result: { success: m.budgets_success_deleted() },
			lines: []
		});
	});
});
