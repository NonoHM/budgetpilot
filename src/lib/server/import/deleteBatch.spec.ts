import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared delete, at the level a unit test can reach.
 *
 * What is asserted here is the SHAPE of the calls, because that is all a mocked Prisma can answer
 * for. Whether the cascade actually removes a split, and whether a second batch survives the
 * delete of the first, are questions about engines rather than about this function, and they live
 * in `deleteBatch.db-smoke.ts` where three of them run.
 */
const db = vi.hoisted(() => ({
	prisma: {
		importBatch: { findFirst: vi.fn(), delete: vi.fn() },
		transaction: { deleteMany: vi.fn() },
		$transaction: vi.fn(async (ops: unknown[]) => ops)
	}
}));
vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { deleteImportBatch } = await import('./deleteBatch');

beforeEach(() => {
	vi.clearAllMocks();
});

describe('deleteImportBatch', () => {
	it('refuses a batch that belongs to another user, and deletes nothing', async () => {
		// `findFirst` is scoped by userId, so another user's batch resolves to null. Asserted on the
		// WRITES rather than on the return value: a version that returned false and deleted anyway
		// would pass a return-value test, and it is the writes that are irreversible.
		db.prisma.importBatch.findFirst.mockResolvedValueOnce(null);

		const deleted = await deleteImportBatch('user-1', 'batch-of-user-2');

		expect(deleted).toBe(false);
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
		expect(db.prisma.transaction.deleteMany).not.toHaveBeenCalled();
		expect(db.prisma.importBatch.delete).not.toHaveBeenCalled();
	});

	it('scopes the lookup by userId rather than trusting the id it was handed', async () => {
		// Asserted on the CLAUSE, because Prisma treats a missing clause as no filter: a lookup that
		// dropped `userId` returns the same batch here and passes a test written on the answer.
		db.prisma.importBatch.findFirst.mockResolvedValueOnce({ id: 'batch-1' });

		await deleteImportBatch('user-1', 'batch-1');

		expect(db.prisma.importBatch.findFirst).toHaveBeenCalledWith({
			where: { id: 'batch-1', userId: 'user-1' },
			select: { id: true }
		});
	});

	it('deletes the transactions and the batch together, both scoped by userId', async () => {
		db.prisma.importBatch.findFirst.mockResolvedValueOnce({ id: 'batch-1' });

		const deleted = await deleteImportBatch('user-1', 'batch-1');

		expect(deleted).toBe(true);
		expect(db.prisma.transaction.deleteMany).toHaveBeenCalledWith({
			where: { userId: 'user-1', importBatchId: 'batch-1' }
		});
		expect(db.prisma.importBatch.delete).toHaveBeenCalledWith({ where: { id: 'batch-1' } });
		// One call, so the two writes are one unit. This one CAN be a transaction, unlike the write
		// path it will be sequenced against: nothing here catches a constraint violation and carries
		// on. The reason that distinction matters is in the module's docstring.
		expect(db.prisma.$transaction).toHaveBeenCalledTimes(1);
	});
});
