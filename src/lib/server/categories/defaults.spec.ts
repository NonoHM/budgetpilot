import { beforeEach, describe, expect, it, vi } from 'vitest';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import * as m from '$lib/paraglide/messages';

const db = vi.hoisted(() => ({
	prisma: {
		user: {
			updateMany: vi.fn()
		},
		category: {
			findMany: vi.fn(),
			upsert: vi.fn()
		},
		categoryNatureMapping: {
			findMany: vi.fn(),
			upsert: vi.fn()
		}
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { ensureDefaultCategoriesSeeded, restoreMissingDefaultCategories, DEFAULT_CATEGORIES } =
	await import('./defaults');

/** The `create` payload of every category upsert, in call order. */
function upsertedCategories() {
	return db.prisma.category.upsert.mock.calls.map((call) => call[0].create as { name: string });
}

describe('ensureDefaultCategoriesSeeded', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.prisma.category.upsert.mockResolvedValue({ id: 'category-1' });
		db.prisma.categoryNatureMapping.upsert.mockResolvedValue({ id: 'mapping-1' });
	});

	it('seeds the 14 categories and their 14 nature mappings for a new account', async () => {
		expect.assertions(3);

		db.prisma.user.updateMany.mockResolvedValue({ count: 1 });
		db.prisma.category.findMany.mockResolvedValue([]);
		db.prisma.categoryNatureMapping.findMany.mockResolvedValue([]);

		const result = await ensureDefaultCategoriesSeeded('user-new');

		expect(result).toBe(true);
		expect(db.prisma.category.upsert).toHaveBeenCalledTimes(DEFAULT_CATEGORIES.length);
		expect(db.prisma.categoryNatureMapping.upsert).toHaveBeenCalledTimes(DEFAULT_CATEGORIES.length);
	});

	it('includes the "Revenus" category with the "income" nature', () => {
		expect.assertions(1);

		expect(DEFAULT_CATEGORIES).toContainEqual({ key: 'income', name: 'Revenus', nature: 'income' });
	});

	it('writes nothing on a second call, since the seed claim already lost', async () => {
		expect.assertions(3);

		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });

		const result = await ensureDefaultCategoriesSeeded('user-already-seeded');

		expect(result).toBe(false);
		expect(db.prisma.category.upsert).not.toHaveBeenCalled();
		expect(db.prisma.categoryNatureMapping.upsert).not.toHaveBeenCalled();
	});

	it('creates only the categories that are missing', async () => {
		expect.assertions(5); // 1 result + 1 length + 3 absences, one per existing name

		const existingNames = ['Alimentation', 'Transport', 'Logement'];
		db.prisma.user.updateMany.mockResolvedValue({ count: 1 });
		db.prisma.category.findMany.mockResolvedValue(existingNames.map((name) => ({ name })));
		db.prisma.categoryNatureMapping.findMany.mockResolvedValue(
			existingNames.map((name) => ({ categoryName: name }))
		);

		const result = await ensureDefaultCategoriesSeeded('user-partial');

		expect(result).toBe(true);
		const created = upsertedCategories().map((row) => row.name);
		expect(created).toHaveLength(DEFAULT_CATEGORIES.length - existingNames.length);
		for (const existing of existingNames) {
			expect(created).not.toContain(existing);
		}
	});

	it('treats a differently-spelled existing category as already present', async () => {
		expect.assertions(2);

		// The comparison is the folded name, so restoring the defaults must not add a second
		// "Loisirs" to a user who renamed theirs to "loisirs".
		db.prisma.user.updateMany.mockResolvedValue({ count: 1 });
		db.prisma.category.findMany.mockResolvedValue([{ name: 'loisirs' }, { name: 'TRANSPORT' }]);
		db.prisma.categoryNatureMapping.findMany.mockResolvedValue([]);

		await ensureDefaultCategoriesSeeded('user-renamed');

		const created = upsertedCategories().map((row) => row.name);
		expect(created).not.toContain('Loisirs');
		expect(created).not.toContain('Transport');
	});
});

describe('restoreMissingDefaultCategories', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.prisma.category.upsert.mockResolvedValue({ id: 'category-1' });
		db.prisma.categoryNatureMapping.upsert.mockResolvedValue({ id: 'mapping-1' });
	});

	it('upserts on the folded key rather than inserting blind', async () => {
		expect.assertions(2);

		// Unlike the seed path there is no `defaultsSeededAt` claim here: this is a plain
		// button, so two clicks both read the same missing set. Upserting keyed on the folded
		// name is what makes the second one do nothing instead of hitting the unique constraint.
		db.prisma.category.findMany.mockResolvedValue([]);
		db.prisma.categoryNatureMapping.findMany.mockResolvedValue([]);

		await restoreMissingDefaultCategories('user-restoring');

		const [firstCall] = db.prisma.category.upsert.mock.calls;
		expect(firstCall[0].where).toHaveProperty('userId_nameKey.userId', 'user-restoring');
		expect(firstCall[0].update).toEqual({});
	});

	it('reports how many categories were missing', async () => {
		expect.assertions(1);

		db.prisma.category.findMany.mockResolvedValue(
			DEFAULT_CATEGORIES.slice(2).map(({ name }) => ({ name }))
		);
		db.prisma.categoryNatureMapping.findMany.mockResolvedValue([]);

		await expect(restoreMissingDefaultCategories('user-restoring')).resolves.toBe(2);
	});

	it('recreates Alimentation beside a user category called Groceries, which is now correct (#162)', async () => {
		expect.assertions(2);
		overwriteGetLocale(() => 'en');

		// THIS TEST ASSERTED THE OPPOSITE BEFORE #162, and the reversal is the point rather than a
		// regression. A user on an English instance who deleted the seeded food category and made
		// their own "Groceries" used to be spared a second row, because "Alimentation" was
		// DISPLAYED as Groceries and recreating it would have shown two rows a reader takes for
		// one category.
		//
		// Nothing displays as Groceries any more. "Groceries" and "Alimentation" are two names,
		// they read as two names on every screen, and restoring the defaults gives the user back
		// the one they deleted without touching the one they wrote. Suppressing it now would be
		// the defect: "Restore default categories" would silently skip a default for a reason
		// invisible on screen.
		db.prisma.category.findMany.mockResolvedValue([
			{ name: m.category_default_food({}, { locale: 'en' }) }
		]);
		db.prisma.categoryNatureMapping.findMany.mockResolvedValue([]);

		const created = await restoreMissingDefaultCategories('user-restoring');

		expect(created).toBe(DEFAULT_CATEGORIES.length);
		expect(upsertedCategories().map((c) => c.name)).toContain('Alimentation');

		overwriteGetLocale(() => 'fr');
	});
});
