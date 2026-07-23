import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	prisma: {
		user: {
			updateMany: vi.fn()
		},
		category: {
			findMany: vi.fn(),
			createMany: vi.fn()
		},
		categoryNatureMapping: {
			findMany: vi.fn(),
			createMany: vi.fn()
		}
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { ensureDefaultCategoriesSeeded, DEFAULT_CATEGORIES } = await import('./defaults');

describe('ensureDefaultCategoriesSeeded', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('compte neuf → retourne true et crée les 14 catégories et leurs 14 mappings', async () => {
		expect.assertions(5);

		db.prisma.user.updateMany.mockResolvedValue({ count: 1 });
		db.prisma.category.findMany.mockResolvedValue([]);
		db.prisma.categoryNatureMapping.findMany.mockResolvedValue([]);
		db.prisma.category.createMany.mockResolvedValue({ count: DEFAULT_CATEGORIES.length });
		db.prisma.categoryNatureMapping.createMany.mockResolvedValue({
			count: DEFAULT_CATEGORIES.length
		});

		const result = await ensureDefaultCategoriesSeeded('user-new');

		expect(result).toBe(true);
		expect(db.prisma.category.createMany).toHaveBeenCalledOnce();
		expect(db.prisma.category.createMany.mock.calls[0][0].data).toHaveLength(
			DEFAULT_CATEGORIES.length
		);
		expect(db.prisma.categoryNatureMapping.createMany).toHaveBeenCalledOnce();
		expect(db.prisma.categoryNatureMapping.createMany.mock.calls[0][0].data).toHaveLength(
			DEFAULT_CATEGORIES.length
		);
	});

	it('inclut la catégorie "Revenus" avec la nature "income"', () => {
		expect.assertions(1);

		expect(DEFAULT_CATEGORIES).toContainEqual({ key: 'income', name: 'Revenus', nature: 'income' });
	});

	it("2e appel (updateMany → count:0) → retourne false et n'appelle aucun createMany", async () => {
		expect.assertions(3);

		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });

		const result = await ensureDefaultCategoriesSeeded('user-already-seeded');

		expect(result).toBe(false);
		expect(db.prisma.category.createMany).not.toHaveBeenCalled();
		expect(db.prisma.categoryNatureMapping.createMany).not.toHaveBeenCalled();
	});

	it('catégories partiellement présentes → seules les absentes sont créées', async () => {
		expect.assertions(5); // 1 result + 1 length + 3 not.toContain (one per existing name)

		const existingNames = ['Alimentation', 'Transport', 'Logement'];
		db.prisma.user.updateMany.mockResolvedValue({ count: 1 });
		db.prisma.category.findMany.mockResolvedValue(existingNames.map((name) => ({ name })));
		db.prisma.categoryNatureMapping.findMany.mockResolvedValue(
			existingNames.map((name) => ({ categoryName: name }))
		);
		db.prisma.category.createMany.mockResolvedValue({
			count: DEFAULT_CATEGORIES.length - existingNames.length
		});
		db.prisma.categoryNatureMapping.createMany.mockResolvedValue({
			count: DEFAULT_CATEGORIES.length - existingNames.length
		});

		const result = await ensureDefaultCategoriesSeeded('user-partial');

		expect(result).toBe(true);
		const createdNames = db.prisma.category.createMany.mock.calls[0][0].data.map(
			(d: { name: string }) => d.name
		);
		expect(createdNames).toHaveLength(DEFAULT_CATEGORIES.length - existingNames.length);
		// None of the already-present categories should reappear
		for (const existing of existingNames) {
			expect(createdNames).not.toContain(existing);
		}
	});
});
