import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeNameKey } from '$lib/server/naming/nameKey';

const db = vi.hoisted(() => {
	// Must stay aligned with UNCLASSIFIED_CATEGORY ($lib/domain/categories) — literal
	// required here because vi.hoisted() runs before module imports are ready.
	const UNCLASSIFIED_CATEGORY = 'uncategorized';

	type Category = { id: string; userId: string; name: string; defaultKey: string | null };
	type NatureMapping = { id: string; userId: string; categoryName: string; nature: string };
	type Budget = { id: string; userId: string; categoryName: string; amountCents: number };

	const categories: Category[] = [
		{ id: 'cat-alimentation', userId: 'user-a', name: 'Alimentation', defaultKey: 'food' },
		{ id: 'cat-non-classe', userId: 'user-a', name: UNCLASSIFIED_CATEGORY, defaultKey: null }
	];
	const mappings: NatureMapping[] = [
		{
			id: 'mapping-alimentation',
			userId: 'user-a',
			categoryName: 'Alimentation',
			nature: 'spending'
		}
	];
	const budgets: Budget[] = [
		{
			id: 'budget-alimentation',
			userId: 'user-a',
			categoryName: 'Alimentation',
			amountCents: 50_000
		}
	];

	return {
		categories,
		mappings,
		budgets,
		prisma: {
			category: {
				findFirst: vi.fn(
					async ({ where }) =>
						categories.find(
							(cat) =>
								cat.userId === where.userId &&
								(where.id
									? cat.id === where.id
									: computeNameKey(cat.name) === where.nameKey &&
										(!where.id?.not || cat.id !== where.id.not))
						) ?? null
				),
				upsert: vi.fn(async ({ where, create }) => {
					// Keyed on the folded name, matching the unique constraint the real table now
					// carries: two spellings of one category resolve to the same row.
					const existing = categories.find(
						(cat) =>
							cat.userId === where.userId_nameKey.userId &&
							computeNameKey(cat.name) === where.userId_nameKey.nameKey
					);
					if (existing) return existing;
					const created = { defaultKey: null, ...create };
					categories.push(created);
					return created;
				}),
				delete: vi.fn(async ({ where }) => {
					const index = categories.findIndex((cat) => cat.id === where.id);
					const [removed] = categories.splice(index, 1);
					return removed;
				}),
				update: vi.fn(async ({ where, data }) => {
					const cat = categories.find((c) => c.id === where.id);
					if (cat) Object.assign(cat, data);
					return cat;
				})
			},
			transaction: {
				count: vi.fn(async () => 0),
				updateMany: vi.fn(async () => ({ count: 0 }))
			},
			categoryNatureMapping: {
				deleteMany: vi.fn(async ({ where }) => {
					const before = mappings.length;
					for (let i = mappings.length - 1; i >= 0; i--) {
						if (
							mappings[i].userId === where.userId &&
							computeNameKey(mappings[i].categoryName) === where.categoryNameKey
						) {
							mappings.splice(i, 1);
						}
					}
					return { count: before - mappings.length };
				}),
				updateMany: vi.fn(async ({ where, data }) => {
					let count = 0;
					for (const mapping of mappings) {
						if (
							mapping.userId === where.userId &&
							computeNameKey(mapping.categoryName) === where.categoryNameKey
						) {
							Object.assign(mapping, data);
							count++;
						}
					}
					return { count };
				})
			},
			monthlyBudget: {
				deleteMany: vi.fn(async ({ where }) => {
					const before = budgets.length;
					for (let i = budgets.length - 1; i >= 0; i--) {
						if (
							budgets[i].userId === where.userId &&
							computeNameKey(budgets[i].categoryName) === where.categoryNameKey
						) {
							budgets.splice(i, 1);
						}
					}
					return { count: before - budgets.length };
				})
			},
			$transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops))
		}
	};
});

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

// Must stay aligned with UNCLASSIFIED_CATEGORY ($lib/domain/categories).
const UNCLASSIFIED_CATEGORY = 'uncategorized';

const { actions } = await import('./+page.server');
const testUser = { id: 'user-a', email: 'a@example.test', role: 'USER' as const };

describe('deleteCategory — orphelins CategoryNatureMapping / MonthlyBudget', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.categories.length = 0;
		db.categories.push(
			{ id: 'cat-alimentation', userId: 'user-a', name: 'Alimentation', defaultKey: 'food' },
			{ id: 'cat-non-classe', userId: 'user-a', name: UNCLASSIFIED_CATEGORY, defaultKey: null }
		);
		db.mappings.length = 0;
		db.mappings.push({
			id: 'mapping-alimentation',
			userId: 'user-a',
			categoryName: 'Alimentation',
			nature: 'spending'
		});
		db.budgets.length = 0;
		db.budgets.push({
			id: 'budget-alimentation',
			userId: 'user-a',
			categoryName: 'Alimentation',
			amountCents: 50_000
		});
	});

	it('supprime le CategoryNatureMapping orphelin à la suppression de la catégorie', async () => {
		expect.assertions(2);

		await runAction('deleteCategory', { id: 'cat-alimentation' });

		expect(db.prisma.categoryNatureMapping.deleteMany).toHaveBeenCalledWith({
			where: { userId: 'user-a', categoryNameKey: computeNameKey('Alimentation') }
		});
		expect(db.mappings).toHaveLength(0);
	});

	it('supprime le MonthlyBudget orphelin à la suppression de la catégorie', async () => {
		expect.assertions(2);

		await runAction('deleteCategory', { id: 'cat-alimentation' });

		expect(db.prisma.monthlyBudget.deleteMany).toHaveBeenCalledWith({
			where: { userId: 'user-a', categoryNameKey: computeNameKey('Alimentation') }
		});
		expect(db.budgets).toHaveLength(0);
	});

	it("ne plante pas si la catégorie n'a ni mapping ni budget associé", async () => {
		expect.assertions(3);
		db.categories.push({ id: 'cat-loisirs', userId: 'user-a', name: 'Loisirs', defaultKey: null });

		const result = await runAction('deleteCategory', { id: 'cat-loisirs' });

		expect(result.status).toBeUndefined();
		expect(db.mappings).toHaveLength(1); // mapping "Alimentation" intact
		expect(db.budgets).toHaveLength(1); // budget "Alimentation" intact
	});

	it("ne supprime pas le mapping d'un autre utilisateur portant le même categoryName", async () => {
		expect.assertions(2);
		db.mappings.push({
			id: 'mapping-alimentation-user-b',
			userId: 'user-b',
			categoryName: 'Alimentation',
			nature: 'spending'
		});

		await runAction('deleteCategory', { id: 'cat-alimentation' });

		expect(db.mappings).toHaveLength(1);
		expect(db.mappings[0]).toMatchObject({ userId: 'user-b', categoryName: 'Alimentation' });
	});

	it("ne supprime pas le budget d'un autre utilisateur portant le même categoryName", async () => {
		expect.assertions(2);
		db.budgets.push({
			id: 'budget-alimentation-user-b',
			userId: 'user-b',
			categoryName: 'Alimentation',
			amountCents: 12_000
		});

		await runAction('deleteCategory', { id: 'cat-alimentation' });

		expect(db.budgets).toHaveLength(1);
		expect(db.budgets[0]).toMatchObject({ userId: 'user-b', categoryName: 'Alimentation' });
	});

	it('réassigne les transactions à "Non catégorisé" en plus de nettoyer les orphelins', async () => {
		expect.assertions(3);
		db.prisma.transaction.count.mockResolvedValueOnce(3);

		const result = await runAction('deleteCategory', { id: 'cat-alimentation' });

		expect(db.prisma.transaction.updateMany).toHaveBeenNthCalledWith(1, {
			where: { categoryId: 'cat-alimentation', userId: 'user-a' },
			data: { categoryId: 'cat-non-classe' }
		});
		expect(result.success).toBeTruthy();
		expect(db.mappings).toHaveLength(0);
	});
});

describe('renameCategory — pas de régression sur le mapping', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.categories.length = 0;
		db.categories.push(
			{ id: 'cat-alimentation', userId: 'user-a', name: 'Alimentation', defaultKey: 'food' },
			{ id: 'cat-non-classe', userId: 'user-a', name: UNCLASSIFIED_CATEGORY, defaultKey: null }
		);
		db.mappings.length = 0;
		db.mappings.push({
			id: 'mapping-alimentation',
			userId: 'user-a',
			categoryName: 'Alimentation',
			nature: 'spending'
		});
		db.budgets.length = 0;
	});

	it("fait suivre le categoryName du mapping via updateMany (pas de suppression, pas d'orphelin)", async () => {
		expect.assertions(3);

		await runAction('renameCategory', { id: 'cat-alimentation', newName: 'Courses' });

		expect(db.prisma.categoryNatureMapping.deleteMany).not.toHaveBeenCalled();
		expect(db.prisma.categoryNatureMapping.updateMany).toHaveBeenCalledWith({
			where: { userId: 'user-a', categoryNameKey: computeNameKey('Alimentation') },
			data: { categoryName: 'Courses', categoryNameKey: computeNameKey('Courses') }
		});
		expect(db.mappings[0]).toMatchObject({ categoryName: 'Courses' });
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
		request: new Request('http://localhost/categories', { method: 'POST', body: formData })
	})) as { status?: number; success?: string };
}
