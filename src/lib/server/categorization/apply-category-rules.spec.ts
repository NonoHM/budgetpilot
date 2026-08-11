import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
	id: string;
	userId: string;
	label: string;
	manualCategory: string | null;
	natureManual: string | null;
	categoryId: string;
	/** Only `previewCategoryRules` selects it, as `category: { select: { name: true } }`. */
	categoryName?: string;
};

const db = vi.hoisted(() => ({
	rows: [] as Row[],
	categories: [] as Array<{ userId: string; name: string }>,
	prisma: {
		category: {
			findMany: vi.fn()
		},
		categoryRule: {
			findMany: vi.fn()
		},
		transaction: {
			findMany: vi.fn(),
			updateMany: vi.fn()
		}
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { applyCategoryRules, previewCategoryRules } = await import('./rules');

/**
 * The user's categories, as `readCategoryNameKeys` reads them.
 *
 * Every test declares its own rather than inheriting a permissive default, and that is the point:
 * whether a category exists is now what decides whether a rule fires, so a fixture that supplied
 * it silently would hide exactly the property these tests exist to pin.
 */
function setUpCategories(names: string[], userId = 'user-1') {
	db.categories = names.map((name) => ({ userId, name }));

	db.prisma.category.findMany.mockImplementation(
		async ({ where }: { where: Record<string, unknown> }) => {
			// Fails loudly on a predicate it does not model rather than approximating one. A fake
			// that narrows is survivable (it errors, and you go look); a fake that WIDENS or ignores
			// an unknown key is the one that ships, because every assertion about exclusion then
			// passes vacuously.
			const keys = Object.keys(where);
			if (keys.length !== 1 || keys[0] !== 'userId') {
				throw new Error(`category.findMany fake does not model where: ${JSON.stringify(where)}`);
			}
			return db.categories.filter((c) => c.userId === where.userId).map((c) => ({ name: c.name }));
		}
	);
}

function setUpRows(rows: Row[]) {
	db.rows = rows;

	db.prisma.transaction.findMany.mockImplementation(
		async ({
			where
		}: {
			where: { userId: string; manualCategory: null; id?: { in: string[] }; categoryId?: string };
		}) => {
			return db.rows
				.filter((r) => r.userId === where.userId && r.manualCategory === where.manualCategory)
				.filter((r) => !where.id || where.id.in.includes(r.id))
				.filter((r) => !where.categoryId || r.categoryId === where.categoryId)
				.map((r) => ({
					id: r.id,
					label: r.label,
					manualCategory: r.manualCategory,
					natureManual: r.natureManual,
					category: { name: r.categoryName ?? 'Non catégorisé' }
				}));
		}
	);

	db.prisma.transaction.updateMany.mockImplementation(
		async ({
			where,
			data
		}: {
			where: { id: { in: string[] }; userId: string; manualCategory: null; natureManual?: null };
			data: { manualCategory: string; natureManual?: string };
		}) => {
			let count = 0;
			for (const row of db.rows) {
				if (!where.id.in.includes(row.id)) continue;
				if (row.userId !== where.userId) continue;
				if (row.manualCategory !== where.manualCategory) continue;
				if ('natureManual' in where && row.natureManual !== where.natureManual) continue;

				row.manualCategory = data.manualCategory;
				if ('natureManual' in data) row.natureManual = data.natureManual ?? null;
				count += 1;
			}
			return { count };
		}
	);
}

describe('applyCategoryRules', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.rows = [];
	});

	it('regroupe les transactions matchées par règle et met à jour le même nombre de lignes que la logique ligne à ligne', async () => {
		expect.assertions(3);

		setUpCategories(['Alimentation', 'Transport']);
		db.prisma.categoryRule.findMany.mockResolvedValue([
			{
				id: 'rule-a',
				name: 'Auchan',
				matchText: 'auchan',
				targetCategory: 'Alimentation',
				targetNature: 'spending',
				enabled: true,
				isRegex: false
			},
			{
				id: 'rule-b',
				name: 'Uber',
				matchText: 'uber',
				targetCategory: 'Transport',
				targetNature: null,
				enabled: true,
				isRegex: false
			}
		]);

		setUpRows([
			{
				id: 't1',
				userId: 'user-1',
				label: 'AUCHAN paris',
				manualCategory: null,
				natureManual: null,
				categoryId: 'cat-uncat'
			},
			{
				id: 't2',
				userId: 'user-1',
				label: 'Auchan drive',
				manualCategory: null,
				natureManual: null,
				categoryId: 'cat-uncat'
			},
			// Nature already set manually in the meantime: must not be overwritten
			// (natureManual: null guard per row, preserved despite batching).
			{
				id: 't3',
				userId: 'user-1',
				label: 'auchan bis',
				manualCategory: null,
				natureManual: 'transfer',
				categoryId: 'cat-uncat'
			},
			{
				id: 't4',
				userId: 'user-1',
				label: 'Uber ride',
				manualCategory: null,
				natureManual: 'income',
				categoryId: 'cat-uncat'
			},
			{
				id: 't5',
				userId: 'user-1',
				label: 'Uber eats',
				manualCategory: null,
				natureManual: null,
				categoryId: 'cat-uncat'
			}
		]);

		const updated = await applyCategoryRules('user-1');

		// t1, t2 (Auchan rule) + t4, t5 (Uber rule) = 4; t3 excluded by the natureManual guard.
		expect(updated).toBe(4);
		// One updateMany per rule group (2), not one per matched transaction (4).
		expect(db.prisma.transaction.updateMany).toHaveBeenCalledTimes(2);
		expect(db.rows.find((r) => r.id === 't3')?.natureManual).toBe('transfer');
	});

	it("scope à un categoryId (pile 'à classer' via classifyAll) sans toucher aux autres catégories", async () => {
		expect.assertions(2);

		setUpCategories(['Alimentation']);
		db.prisma.categoryRule.findMany.mockResolvedValue([
			{
				id: 'rule-a',
				name: 'Auchan',
				matchText: 'auchan',
				targetCategory: 'Alimentation',
				targetNature: null,
				enabled: true,
				isRegex: false
			}
		]);

		setUpRows([
			{
				id: 't1',
				userId: 'user-1',
				label: 'Auchan paris',
				manualCategory: null,
				natureManual: null,
				categoryId: 'cat-uncat'
			},
			// Same label match, but a different (already-categorized) bucket — classifyAll's
			// categoryId scoping must not touch it, only rules/+page.server.ts's global
			// "apply rules" (no categoryId) does.
			{
				id: 't2',
				userId: 'user-1',
				label: 'Auchan lyon',
				manualCategory: null,
				natureManual: null,
				categoryId: 'cat-food'
			}
		]);

		const updated = await applyCategoryRules('user-1', { categoryId: 'cat-uncat' });

		expect(updated).toBe(1);
		expect(db.rows.find((r) => r.id === 't2')?.manualCategory).toBeNull();
	});

	// #161. THE BREAK-CHECK LIVES HERE, and what it has to prove is not "the rule did not fire"
	// but "the deleted name did not come back". Those are different assertions and only the second
	// one names the defect: a rule left pointing at a deleted category makes the next rules run
	// write that name onto transactions, including the ones the delete had just moved to the
	// fallback, so the delete leaves a mechanism that reverses itself.
	//
	// Removing the `isRuleTargetLive` filter in `applyCategoryRules` must turn this red. The line
	// is reachable: the rule row is still `enabled: true`, so the SQL filter that was already there
	// does not cover the case, and a green here would be a finding rather than a pass. That is
	// worth stating because the stored alternative does NOT have this property: had the delete
	// written `enabled = false`, the pre-existing `enabled: true` filter would have covered the
	// case on its own, this break would have gone green, and the correct reading of that green
	// would have been "there is no guard here to hold" rather than "the guard holds".
	it('does not write a deleted category name back onto a transaction', async () => {
		expect.assertions(3);

		// "Loisirs" has been deleted; the rule that targeted it survives, untouched and enabled.
		setUpCategories(['Alimentation']);
		db.prisma.categoryRule.findMany.mockResolvedValue([
			{
				id: 'rule-loisirs',
				name: 'Cinema',
				matchText: 'ugc',
				targetCategory: 'Loisirs',
				targetNature: null,
				enabled: true,
				isRegex: false
			}
		]);

		setUpRows([
			{
				id: 't1',
				userId: 'user-1',
				label: 'UGC Bercy',
				manualCategory: null,
				natureManual: null,
				categoryId: 'cat-uncat'
			}
		]);

		const updated = await applyCategoryRules('user-1');

		expect(updated).toBe(0);
		expect(db.rows.find((r) => r.id === 't1')?.manualCategory).toBeNull();
		// The write is the defect, so the absence of the write is the figure. Asserting on the row
		// alone would still pass if a later change made the engine write the name through some
		// other call.
		expect(db.prisma.transaction.updateMany).not.toHaveBeenCalled();
	});

	// The fold has to agree with `renameCategoryReferences`, which matches a rule stored as
	// "loisirs" to the "Loisirs" being renamed. If this pair disagreed, a rule the rename would
	// happily repoint would be treated as pointing at nothing and silently stop firing.
	it('keeps a rule live when its target differs from the category only by case and accent', async () => {
		expect.assertions(2);

		setUpCategories(['Alimentation']);
		db.prisma.categoryRule.findMany.mockResolvedValue([
			{
				id: 'rule-food',
				name: 'Auchan',
				matchText: 'auchan',
				targetCategory: 'alimentation',
				targetNature: null,
				enabled: true,
				isRegex: false
			}
		]);

		setUpRows([
			{
				id: 't1',
				userId: 'user-1',
				label: 'AUCHAN paris',
				manualCategory: null,
				natureManual: null,
				categoryId: 'cat-uncat'
			}
		]);

		const updated = await applyCategoryRules('user-1');

		expect(updated).toBe(1);
		// The rule's own spelling is what gets written, exactly as before: resolving the target
		// decides WHETHER the rule fires, never what it writes.
		expect(db.rows.find((r) => r.id === 't1')?.manualCategory).toBe('alimentation');
	});

	it("ne modifie rien et ne fait aucun appel updateMany si aucune règle activée n'existe", async () => {
		expect.assertions(2);

		setUpCategories(['Alimentation']);
		db.prisma.categoryRule.findMany.mockResolvedValue([]);
		setUpRows([]);

		const updated = await applyCategoryRules('user-1');

		expect(updated).toBe(0);
		expect(db.prisma.transaction.updateMany).not.toHaveBeenCalled();
	});
});

// Shares the harness above rather than opening a second fake of the same three tables. The pairing
// is the subject anyway: the preview's whole contract is that it predicts what the apply does.
describe('previewCategoryRules', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.rows = [];
	});

	// #161. Its own break-check, and not redundant with the apply one: this filter and that one are
	// two call sites of the same predicate, and the failure they guard against is different. Here
	// nothing is written, so the defect is a NUMBER: the user is told "N transactions will be
	// recategorised", presses the button, and a smaller number moves, with nothing on screen
	// explaining the gap. Deleting the filter in previewCategoryRules leaves every apply test green.
	it('does not count a transaction a paused rule can no longer recategorise', async () => {
		expect.assertions(2);

		setUpCategories(['Alimentation']);
		db.prisma.categoryRule.findMany.mockResolvedValue([
			{
				id: 'rule-loisirs',
				name: 'Cinema',
				matchText: 'ugc',
				targetCategory: 'Loisirs',
				targetNature: null,
				enabled: true,
				isRegex: false
			}
		]);

		setUpRows([
			{
				id: 't1',
				userId: 'user-1',
				label: 'UGC Bercy',
				manualCategory: null,
				natureManual: null,
				categoryId: 'cat-uncat',
				categoryName: 'Non catégorisé'
			}
		]);

		const preview = await previewCategoryRules('user-1');

		expect(preview.count).toBe(0);
		// The examples list is what the user actually reads. A count of 0 beside a populated list
		// would be the same false promise in a second place.
		expect(preview.examples).toEqual([]);
	});

	it('counts a transaction a live rule will recategorise', async () => {
		expect.assertions(2);

		setUpCategories(['Alimentation']);
		db.prisma.categoryRule.findMany.mockResolvedValue([
			{
				id: 'rule-food',
				name: 'Auchan',
				matchText: 'auchan',
				targetCategory: 'Alimentation',
				targetNature: null,
				enabled: true,
				isRegex: false
			}
		]);

		setUpRows([
			{
				id: 't1',
				userId: 'user-1',
				label: 'AUCHAN paris',
				manualCategory: null,
				natureManual: null,
				categoryId: 'cat-uncat',
				categoryName: 'Non catégorisé'
			}
		]);

		const preview = await previewCategoryRules('user-1');

		expect(preview.count).toBe(1);
		expect(preview.examples[0]?.targetCategory).toBe('Alimentation');
	});
});
