import { describe, expect, it, vi } from 'vitest';
import { GENERIC_BUCKET_STORED_NAME } from '$lib/domain/account';
import * as m from '$lib/paraglide/messages';

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
			_count: { transactions: 2 },
			// The joined account, in the shape `displayAccountName` reads. The STORED name, not the
			// rendered one: this fixture is the row, and the substitution is what the load is being
			// asserted to perform on it.
			account: {
				name: 'Compte import CSV',
				// NULL, and deliberately: this fixture lives inside `vi.hoisted`, which cannot call
				// `computeNameKey`, and the null is not a workaround but the case most likely in the
				// field. The column is nullable, carries no unique constraint, and the boot backfill
				// writes it only for accounts with an institution to write, which the generic bucket
				// has not. `isGenericallyNamed` recomputes the key from the name for exactly this row.
				nameKey: null,
				source: 'csv',
				institution: null
			}
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
	it('projects the display name rather than shipping the stored one', async () => {
		// SEPARATES: « the load calls `displayAccountName` » FROM « the load ships `account.name` ».
		// The fixture is the generic bucket, which is the only row where those two answers differ:
		// its stored name is a lookup key half of `@@unique([userId, name, source])`, and the
		// sentence a user must read is « Import CSV ». A page shipped the raw key would be the one
		// screen in the application showing it.
		//
		// Asserted on the LOAD, not on the chrome. `account-pill.svelte.spec.ts` covers the two
		// chromes and passes them a name; that says nothing about whether the load computes one, and
		// the break matrix confirmed it: removing the projection reddens nothing over there.
		expect.assertions(3);
		const result = (await load({
			locals: { user: testUser },
			url: new URL('http://localhost/imports')
		} as unknown as Parameters<typeof load>[0])) as {
			batches: { accountName: string | null }[];
		};
		expect(result.batches).toHaveLength(1);
		expect(result.batches[0].accountName).toBe(m.accounts_generic_bucket());
		// And the stored key never leaves the server, which is the half that matters if the
		// substitution is ever moved back onto the page.
		expect(result.batches[0].accountName).not.toBe(GENERIC_BUCKET_STORED_NAME);
	});

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
