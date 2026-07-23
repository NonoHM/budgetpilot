import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
	const batches = [
		{
			id: 'batch-123456',
			userId: 'user-a',
			fileName: 'export.csv',
			source: 'banque_populaire',
			profile: 'banque-populaire',
			rowCount: 3,
			importedRows: 2,
			duplicateRows: 1,
			invalidRows: 0,
			periodStart: new Date('2026-06-01T00:00:00.000Z'),
			periodEnd: new Date('2026-06-30T00:00:00.000Z'),
			createdAt: new Date('2026-06-24T10:00:00.000Z'),
			_count: { transactions: 2 }
		}
	];
	const categories = [{ id: 'category-1', name: 'Alimentation' }];
	const transactions = [
		{
			id: 'transaction-1',
			userId: 'user-a',
			importBatchId: 'batch-123456',
			categoryId: 'category-1'
		},
		{
			id: 'transaction-2',
			userId: 'user-a',
			importBatchId: 'other-batch',
			categoryId: 'category-1'
		},
		{ id: 'manual-1', userId: 'user-a', importBatchId: null, categoryId: 'category-1' },
		{
			id: 'other-user-1',
			userId: 'user-b',
			importBatchId: 'batch-123456',
			categoryId: 'category-1'
		}
	];

	return {
		batches,
		categories,
		transactions,
		prisma: {
			importBatch: {
				findMany: vi.fn(async ({ where }) =>
					batches.filter((batch) => batch.userId === where.userId)
				),
				findFirst: vi.fn(
					async ({ where }) =>
						batches.find((batch) => batch.id === where.id && batch.userId === where.userId) ?? null
				),
				delete: vi.fn(async ({ where }) => {
					const index = batches.findIndex((batch) => batch.id === where.id);
					if (index >= 0) batches.splice(index, 1);
					return { id: where.id };
				})
			},
			transaction: {
				deleteMany: vi.fn(async ({ where }) => {
					const before = transactions.length;
					for (let index = transactions.length - 1; index >= 0; index -= 1) {
						if (
							transactions[index].userId === where.userId &&
							transactions[index].importBatchId === where.importBatchId
						) {
							transactions.splice(index, 1);
						}
					}
					return { count: before - transactions.length };
				})
			},
			$transaction: vi.fn(async (operations) => Promise.all(operations))
		}
	};
});

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { actions, load } = await import('./+page.server');
const testUser = { id: 'user-a', email: 'a@example.test', role: 'USER' as const };

interface TestImportsPageData {
	batches: Array<{
		fileName: string | null;
		profile: string;
		importedRows: number;
		periodStart: string | null;
	}>;
}

describe('/imports', () => {
	it('affiche l’historique des imports', async () => {
		expect.assertions(4);

		const data = (await load({
			locals: { user: testUser },
			url: new URL('http://localhost/imports')
		} as Parameters<typeof load>[0])) as TestImportsPageData;

		expect(data.batches).toHaveLength(1);
		expect(data.batches[0]).toMatchObject({
			fileName: 'export.csv',
			profile: 'banque-populaire',
			importedRows: 2
		});
		expect(data.batches[0].periodStart).toBe('2026-06-01');
		expect(db.prisma.importBatch.findMany).toHaveBeenCalled();
	});

	it('annule un import sans supprimer les transactions manuelles ni les catégories', async () => {
		expect.assertions(5);

		const formData = new FormData();
		formData.set('batchId', 'batch-123456');

		await expect(
			(
				actions.cancel as (event: {
					locals: { user: typeof testUser };
					request: Request;
				}) => Promise<unknown>
			)({
				locals: { user: testUser },
				request: new Request('http://localhost/imports', {
					method: 'POST',
					body: formData
				})
			})
		).rejects.toMatchObject({ status: 303 });

		expect(db.prisma.transaction.deleteMany).toHaveBeenCalledWith({
			where: { userId: testUser.id, importBatchId: 'batch-123456' }
		});
		expect(db.transactions).toEqual([
			{
				id: 'transaction-2',
				userId: 'user-a',
				importBatchId: 'other-batch',
				categoryId: 'category-1'
			},
			{ id: 'manual-1', userId: 'user-a', importBatchId: null, categoryId: 'category-1' },
			{
				id: 'other-user-1',
				userId: 'user-b',
				importBatchId: 'batch-123456',
				categoryId: 'category-1'
			}
		]);
		expect(db.categories).toEqual([{ id: 'category-1', name: 'Alimentation' }]);
		expect(db.prisma.importBatch.delete).toHaveBeenCalledWith({ where: { id: 'batch-123456' } });
	});
});
