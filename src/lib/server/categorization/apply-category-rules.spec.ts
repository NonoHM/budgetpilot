import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
	id: string;
	userId: string;
	label: string;
	manualCategory: string | null;
	natureManual: string | null;
	categoryId: string;
};

const db = vi.hoisted(() => ({
	rows: [] as Row[],
	prisma: {
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

const { applyCategoryRules } = await import('./rules');

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
					natureManual: r.natureManual
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

	it("ne modifie rien et ne fait aucun appel updateMany si aucune règle activée n'existe", async () => {
		expect.assertions(2);

		db.prisma.categoryRule.findMany.mockResolvedValue([]);
		setUpRows([]);

		const updated = await applyCategoryRules('user-1');

		expect(updated).toBe(0);
		expect(db.prisma.transaction.updateMany).not.toHaveBeenCalled();
	});
});
