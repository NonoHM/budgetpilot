import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeNameKey } from '$lib/server/naming/nameKey';

const db = vi.hoisted(() => ({
	prisma: {
		transaction: {
			findMany: vi.fn(),
			create: vi.fn()
		},
		monthlyBudget: {
			findMany: vi.fn(),
			findFirst: vi.fn(),
			upsert: vi.fn(),
			updateMany: vi.fn(),
			deleteMany: vi.fn()
		},
		categoryNatureMapping: {
			findMany: vi.fn()
		},
		account: {
			upsert: vi.fn()
		},
		category: {
			upsert: vi.fn(),
			findFirst: vi.fn(),
			findMany: vi.fn()
		}
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const {
	createManualTransaction,
	deleteBudget,
	getCurrentMonth,
	parseManualAmountCents,
	parseMonth,
	readBudgetCategoryOptions,
	readDashboardData,
	readDashboardDataForRange,
	readCurrentMonthSpending,
	readMonthlyBudgets,
	saveBudget,
	spentCentsFor,
	updateBudget
} = await import('./dashboard');

describe('parseManualAmountCents', () => {
	it('convertit un montant manuel en centimes', () => {
		expect.assertions(4);

		expect(parseManualAmountCents('12,34')).toBe(1_234);
		expect(parseManualAmountCents('-42.10')).toBe(-4_210);
		expect(parseManualAmountCents('100')).toBe(10_000);
		expect(parseManualAmountCents('1 234,5')).toBe(123_450);
	});

	it('rejette les montants invalides ou nuls', () => {
		expect.assertions(4);

		expect(parseManualAmountCents('0')).toBeNull();
		expect(parseManualAmountCents('12.345')).toBeNull();
		expect(parseManualAmountCents('abc')).toBeNull();
		expect(parseManualAmountCents('1000000.01')).toBeNull();
	});

	it('rejette un + explicite (contrairement à parseAmountCents côté import)', () => {
		expect(parseManualAmountCents('+42.90')).toBeNull();
	});

	it('accepte un montant juste sous la borne de 100 000 000 centimes', () => {
		expect(parseManualAmountCents('999999.99')).toBe(99_999_999);
	});

	it('rejette un montant juste au-dessus de la borne de 100 000 000 centimes', () => {
		expect(parseManualAmountCents('1000000.01')).toBeNull();
	});

	it('accepte un montant exactement à la borne de 100 000 000 centimes (borne inclusive)', () => {
		expect(parseManualAmountCents('1000000.00')).toBe(100_000_000);
	});

	it("rejette une saisie composée uniquement d'espaces", () => {
		expect(parseManualAmountCents('   ')).toBeNull();
	});
});

describe('saveBudget validation', () => {
	it('réutilise une conversion qui rejette les budgets nuls', () => {
		expect.assertions(1);

		expect(parseManualAmountCents('0')).toBeNull();
	});

	it('rejette une categorie invalide', async () => {
		expect.assertions(1);

		await expect(
			saveBudget('user-a', {
				category: 'Budget<',
				limit: '100'
			})
		).rejects.toMatchObject({ body: { message: 'Catégorie invalide' } });
	});

	it('rejette le nom sentinel "uncategorized" avec le meme message que /categories', async () => {
		expect.assertions(2);

		await expect(
			saveBudget('user-a', {
				category: 'uncategorized',
				limit: '100'
			})
		).rejects.toMatchObject({ status: 400, body: { message: 'Ce nom est réservé.' } });
		expect(db.prisma.category.upsert).not.toHaveBeenCalled();
	});

	it('rejette un montant nul', async () => {
		await expect(saveBudget('user-a', { category: 'Loisirs', limit: '0' })).rejects.toMatchObject({
			status: 400
		});
		expect(db.prisma.category.upsert).not.toHaveBeenCalled();
	});

	it('rejette un montant négatif (un budget ne peut pas être négatif)', async () => {
		await expect(saveBudget('user-a', { category: 'Loisirs', limit: '-50' })).rejects.toMatchObject(
			{
				status: 400
			}
		);
		expect(db.prisma.category.upsert).not.toHaveBeenCalled();
	});

	it('rejette un montant au-dessus de MAX_BUDGET_AMOUNT_CENTS (100 000 000 centimes)', async () => {
		await expect(
			saveBudget('user-a', { category: 'Loisirs', limit: '1000000.01' })
		).rejects.toMatchObject({ status: 400 });
		expect(db.prisma.category.upsert).not.toHaveBeenCalled();
	});

	it('accepte un montant valide', async () => {
		db.prisma.category.upsert.mockResolvedValue({ id: 'cat-1' });
		db.prisma.monthlyBudget.upsert.mockResolvedValue({ id: 'budget-1' });

		await saveBudget('user-a', { category: 'Loisirs', limit: '250' });

		expect(db.prisma.monthlyBudget.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.objectContaining({ amountCents: 25_000 })
			})
		);
	});

	it('accepte un montant juste sous MAX_BUDGET_AMOUNT_CENTS', async () => {
		db.prisma.category.upsert.mockResolvedValue({ id: 'cat-1' });
		db.prisma.monthlyBudget.upsert.mockResolvedValue({ id: 'budget-1' });

		await saveBudget('user-a', { category: 'Loisirs', limit: '999999.99' });

		expect(db.prisma.monthlyBudget.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.objectContaining({ amountCents: 99_999_999 })
			})
		);
	});
});

describe('parseMonth', () => {
	it('accepte un mois YYYY-MM valide', () => {
		expect.assertions(1);

		expect(parseMonth('2026-06')).toBe('2026-06');
	});

	it('rejette un mois hors plage', () => {
		expect.assertions(1);

		expect(() => parseMonth('2026-13')).toThrow();
	});
});

describe('readDashboardData', () => {
	const userId = 'user-a';

	beforeEach(() => {
		vi.clearAllMocks();
		// resolveCategoryByName / upsertBudgetByFoldedName look for an existing folded match
		// before upserting; "none yet" is the default these specs assume.
		db.prisma.category.findFirst.mockResolvedValue(null);
		db.prisma.monthlyBudget.findFirst.mockResolvedValue(null);
		db.prisma.transaction.findMany.mockResolvedValue([
			{
				id: 'income-any-source',
				date: new Date('2026-06-05T00:00:00.000Z'),
				label: 'Salaire',
				amountCents: 200_000,
				type: 'income',
				source: 'unknown_source',
				manualCategory: null,
				natureManual: null,
				category: { name: 'Revenus' },
				splits: []
			},
			{
				id: 'expense-any-source',
				date: new Date('2026-06-10T00:00:00.000Z'),
				label: 'Courses',
				amountCents: -12_000,
				type: 'expense',
				source: 'legacy_import',
				manualCategory: 'Maison',
				natureManual: null,
				category: { name: 'Alimentation' },
				splits: []
			}
		]);
		db.prisma.monthlyBudget.findMany.mockResolvedValue([]);
		db.prisma.categoryNatureMapping.findMany.mockResolvedValue([
			{
				categoryName: 'Maison',
				nature: 'transfer',
				id: 'mapping-1',
				createdAt: new Date(),
				updatedAt: new Date()
			}
		]);
	});

	it('récupère toutes les transactions du mois sans filtre source', async () => {
		expect.assertions(6);

		const data = await readDashboardData(userId, '2026-06');

		expect(db.prisma.transaction.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					userId,
					date: {
						gte: new Date('2026-06-01T00:00:00.000Z'),
						lt: new Date('2026-07-01T00:00:00.000Z')
					}
				}
			})
		);
		expect(db.prisma.monthlyBudget.findMany.mock.calls[0][0].where.userId).toBe(userId);
		expect(db.prisma.transaction.findMany.mock.calls[0][0].where).not.toHaveProperty('source');
		expect(data.transactions.map((transaction) => transaction.id)).toEqual([
			'income-any-source',
			'expense-any-source'
		]);
		expect(data.transactions[1].category).toBe('Maison');
		expect(data.transactions[1].nature).toBe('transfer');
	});

	it('récupère les transactions sur une période glissante sans filtre source', async () => {
		expect.assertions(7);

		db.prisma.transaction.findMany.mockResolvedValueOnce([
			{
				id: 'income-last-month',
				date: new Date('2026-05-28T00:00:00.000Z'),
				label: 'Salaire',
				amountCents: 177_000,
				type: 'income',
				source: 'legacy_import',
				manualCategory: 'Revenus exceptionnels',
				natureManual: null,
				category: { name: 'Revenus' },
				splits: []
			}
		]);

		const data = await readDashboardDataForRange(userId, {
			from: new Date('2026-05-27T00:00:00.000Z'),
			to: new Date('2026-06-26T00:00:00.000Z'),
			budgetMonth: '2026-05'
		});

		expect(db.prisma.transaction.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					userId,
					date: {
						gte: new Date('2026-05-27T00:00:00.000Z'),
						lt: new Date('2026-06-26T00:00:00.000Z')
					}
				}
			})
		);
		expect(db.prisma.monthlyBudget.findMany.mock.calls[0][0].where.userId).toBe(userId);
		expect(db.prisma.transaction.findMany.mock.calls[0][0].where).not.toHaveProperty('source');
		expect(data.transactions[0].id).toBe('income-last-month');
		expect(data.transactions[0].amountCents).toBe(177_000);
		expect(data.transactions[0].category).toBe('Revenus exceptionnels');
		expect(data.transactions[0].nature).toBe('income');
	});
});

describe('écritures dashboard', () => {
	const userId = 'user-a';

	beforeEach(() => {
		vi.clearAllMocks();
		// resolveCategoryByName / upsertBudgetByFoldedName look for an existing folded match
		// before upserting; "none yet" is the default these specs assume.
		db.prisma.category.findFirst.mockResolvedValue(null);
		db.prisma.monthlyBudget.findFirst.mockResolvedValue(null);
		db.prisma.account.upsert.mockResolvedValue({ id: 'account-a' });
		db.prisma.category.upsert.mockResolvedValue({ id: 'category-a', name: 'Alimentation' });
		db.prisma.category.findMany.mockResolvedValue([]);
		db.prisma.transaction.create.mockResolvedValue({ id: 'transaction-a' });
		db.prisma.monthlyBudget.findFirst.mockResolvedValue({
			id: 'budget-a',
			userId,
			categoryName: 'Alimentation',
			amountCents: 50_000
		});
		db.prisma.monthlyBudget.findMany.mockResolvedValue([
			{
				id: 'budget-a',
				categoryName: 'Alimentation',
				amountCents: 50_000,
				createdAt: new Date('2026-06-01T00:00:00.000Z'),
				updatedAt: new Date('2026-06-02T00:00:00.000Z')
			}
		]);
		db.prisma.monthlyBudget.upsert.mockResolvedValue({ id: 'budget-a' });
		db.prisma.monthlyBudget.updateMany.mockResolvedValue({ count: 1 });
		db.prisma.monthlyBudget.deleteMany.mockResolvedValue({ count: 1 });
	});

	it('crée une transaction manuelle avec le userId serveur', async () => {
		expect.assertions(3);

		await createManualTransaction(userId, {
			date: '2026-06-25',
			label: 'Courses',
			amount: '-42,10',
			category: 'Alimentation'
		});

		expect(db.prisma.account.upsert.mock.calls[0][0].where.userId_name_source.userId).toBe(userId);
		expect(db.prisma.category.upsert.mock.calls[0][0].where.userId_nameKey.userId).toBe(userId);
		expect(db.prisma.transaction.create.mock.calls[0][0].data).toMatchObject({
			userId,
			accountId: 'account-a',
			categoryId: 'category-a'
		});
	});

	it('rejette le nom sentinel "uncategorized" pour une transaction manuelle', async () => {
		expect.assertions(3);

		await expect(
			createManualTransaction(userId, {
				date: '2026-06-25',
				label: 'Courses',
				amount: '-42,10',
				category: 'uncategorized'
			})
		).rejects.toMatchObject({ status: 400, body: { message: 'Ce nom est réservé.' } });
		expect(db.prisma.category.upsert).not.toHaveBeenCalled();
		expect(db.prisma.transaction.create).not.toHaveBeenCalled();
	});

	it('scopes every budget write to the calling user', async () => {
		expect.assertions(3);

		await saveBudget(userId, {
			category: 'Alimentation',
			limit: '500'
		});

		// One upsert per table, each keyed on the folded name and scoped to the caller's own
		// userId. No read-then-write: the database decides whether the row already exists, so
		// two concurrent saves cannot each insert their own.
		expect(db.prisma.category.upsert.mock.calls[0][0].where.userId_nameKey.userId).toBe(userId);
		expect(db.prisma.monthlyBudget.upsert.mock.calls[0][0].where).toEqual({
			userId_categoryNameKey: { userId, categoryNameKey: computeNameKey('Alimentation') }
		});
		expect(db.prisma.monthlyBudget.upsert.mock.calls[0][0].update).toEqual({
			amountCents: 50_000
		});
	});

	it('met a jour un budget existant du user courant', async () => {
		expect.assertions(1);

		await updateBudget(userId, 'budget-a', {
			category: 'Alimentation',
			limit: '250'
		});

		expect(db.prisma.monthlyBudget.updateMany).toHaveBeenCalledWith({
			where: { id: 'budget-a', userId },
			data: { amountCents: 25_000 }
		});
	});

	it('supprime un budget seulement pour le user courant', async () => {
		expect.assertions(1);

		await deleteBudget(userId, 'budget-a');

		expect(db.prisma.monthlyBudget.deleteMany).toHaveBeenCalledWith({
			where: { id: 'budget-a', userId }
		});
	});

	it('liste les budgets du user courant', async () => {
		expect.assertions(2);

		const budgets = await readMonthlyBudgets(userId);

		expect(db.prisma.monthlyBudget.findMany).toHaveBeenCalledWith({
			where: { userId },
			orderBy: { categoryName: 'asc' }
		});
		expect(budgets[0].categoryName).toBe('Alimentation');
	});

	it('propose les categories manuelles en priorite effective', async () => {
		expect.assertions(1);

		db.prisma.category.upsert.mockResolvedValue({ id: 'category-a', name: 'Alimentation' });
		db.prisma.category.findMany = vi.fn(async () => [{ name: 'Alimentation' }]);
		db.prisma.transaction.findMany.mockResolvedValue([
			{ manualCategory: 'Maison' },
			{ manualCategory: 'Alimentation' }
		]);

		await expect(readBudgetCategoryOptions(userId)).resolves.toEqual(['Alimentation', 'Maison']);
	});
});

/**
 * The /budgets under-report, reproduced end to end at the two functions that produce it.
 *
 * Measured in a real browser before the fix: /budgets showed 70,00 € for a budget the dashboard
 * showed 74,50 € for, in the same month, and 0,00 € for Transport against the dashboard's 27,00 €.
 * The cause is a spelling: `manualCategory` is free text, so a user who types "alimentation" on
 * one transaction and picks "Alimentation" on another produces two keys in a map every other
 * reader in the app folds into one, and /budgets looked one of them up raw.
 *
 * The fixture is deliberately mixed-case. A fixture spelling every row the way the budget is
 * spelled cannot see this defect at all, which is exactly how it survived.
 */
describe('readCurrentMonthSpending + spentCentsFor — the /budgets under-report', () => {
	const userId = 'user-a';
	/** The instant the whole block is pinned to, stated so a diff cannot be blamed on the calendar. */
	const PINNED_NOW = '2026-08-15T12:00:00.000Z';

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(new Date(PINNED_NOW));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function unsplit(manualCategory: string, amountCents: number) {
		return { amountCents, manualCategory, category: { name: 'Divers' }, splits: [] };
	}

	it('merges two spellings of one category: 70,00 € raw becomes the true 74,50 €', async () => {
		expect.assertions(3);

		db.prisma.transaction.findMany.mockResolvedValue([
			unsplit('Alimentation', -7_000),
			unsplit('alimentation', -450)
		]);

		const spending = await readCurrentMonthSpending(userId);

		// The pre-fix figure, and the reason it was wrong: a raw lookup still finds only one of the
		// two spellings, so this is what /budgets printed.
		expect(spending.get('Alimentation') ?? 0).toBe(0);
		expect(spentCentsFor(spending, 'Alimentation')).toBe(7_450);
		// Folding is symmetric: the budget's own spelling does not decide the answer.
		expect(spentCentsFor(spending, 'ALIMENTATION')).toBe(7_450);
	});

	it('finds a category spelled only in lower case: 0,00 € becomes 27,00 €', async () => {
		expect.assertions(2);

		db.prisma.transaction.findMany.mockResolvedValue([unsplit('transport', -2_700)]);

		const spending = await readCurrentMonthSpending(userId);

		expect(spending.get('Transport') ?? 0).toBe(0);
		expect(spentCentsFor(spending, 'Transport')).toBe(2_700);
	});

	it('folds accents too, the other half of what normalizeForMatch decides', async () => {
		expect.assertions(1);

		db.prisma.transaction.findMany.mockResolvedValue([unsplit('Épargne', -1_000)]);

		const spending = await readCurrentMonthSpending(userId);

		expect(spentCentsFor(spending, 'epargne')).toBe(1_000);
	});

	it('folds the parts of a répartition, not only the parent', async () => {
		expect.assertions(1);

		db.prisma.transaction.findMany.mockResolvedValue([
			{
				amountCents: -8_000,
				manualCategory: null,
				category: { name: 'Courses' },
				splits: [
					{ amountCents: -6_000, position: 0, category: { name: 'Alimentation' } },
					{ amountCents: -2_000, position: 1, category: { name: 'alimentation' } }
				]
			}
		]);

		const spending = await readCurrentMonthSpending(userId);

		expect(spentCentsFor(spending, 'Alimentation')).toBe(8_000);
	});

	it('reads the pinned UTC month, so the range is not the test machine', async () => {
		expect.assertions(1);

		db.prisma.transaction.findMany.mockResolvedValue([]);
		await readCurrentMonthSpending(userId);

		expect(db.prisma.transaction.findMany.mock.calls[0][0].where.date).toEqual({
			gte: new Date('2026-08-01T00:00:00.000Z'),
			lt: new Date('2026-09-01T00:00:00.000Z')
		});
	});
});

/**
 * The /budgets header naming the wrong month, reproduced at the function that names it.
 *
 * Measured before the fix, on a UTC+2 host at 2026-08-31 23:30 UTC: /budgets printed
 * « septembre 2026 » above August's figures, and `loadDashboardInsights` read September, so the
 * budget alerts silently vanished while the dashboard beside them still said August.
 *
 * THE CLOCK AND THE TIMEZONE ARE BOTH STATED, in the test and in its assertions. A harness that
 * embeds a clock must expose the value it used, or a diff is ambiguous between "the code changed"
 * and "the day changed" — and the timezone has to be MOVED for any of this to mean anything: on a
 * UTC host the local and UTC implementations agree at every instant, so every assertion below
 * passes on the broken code. Node re-reads `process.env.TZ` on assignment (tzset), so the swap
 * takes effect in-process.
 */
describe('getCurrentMonth — the /budgets header month', () => {
	const originalTz = process.env.TZ;

	afterEach(() => {
		vi.useRealTimers();
		if (originalTz === undefined) delete process.env.TZ;
		else process.env.TZ = originalTz;
	});

	function pin(tz: string, instantIso: string) {
		process.env.TZ = tz;
		vi.useFakeTimers();
		vi.setSystemTime(new Date(instantIso));
	}

	it('names August at 2026-08-31 23:30 UTC on a UTC+2 host, where the header printed septembre', () => {
		expect.assertions(3);
		pin('Europe/Paris', '2026-08-31T23:30:00.000Z');

		// The host clock really has rolled into September locally — without this the assertion
		// below is vacuous, which is the failure mode this whole block exists to avoid.
		expect(new Date().getMonth() + 1).toBe(9);
		expect(getCurrentMonth()).toBe('2026-08');
		// The reason, not just the value: it agrees with the UTC clock every figure it labels is
		// read against (readDashboardData's Date.UTC range, readCurrentMonthSpending's bounds,
		// the forecast's todayIso).
		expect(getCurrentMonth()).toBe(new Date().toISOString().slice(0, 7));
	});

	it('still names August fourteen hours early, at UTC+14', () => {
		expect.assertions(2);
		pin('Pacific/Kiritimati', '2026-08-31T10:30:00.000Z');

		expect(new Date().getMonth() + 1).toBe(9);
		expect(getCurrentMonth()).toBe('2026-08');
	});

	it('does not lag on a negative-offset host at the other edge of the month', () => {
		expect.assertions(2);
		pin('America/Los_Angeles', '2026-09-01T00:30:00.000Z');

		// Locally it is still August 31st; UTC has already turned.
		expect(new Date().getMonth() + 1).toBe(8);
		expect(getCurrentMonth()).toBe('2026-09');
	});
});
