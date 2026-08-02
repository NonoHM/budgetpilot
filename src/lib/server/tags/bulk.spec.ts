import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fake Prisma for the bulk tag service.
 *
 * Records call arguments rather than simulating a database, like service.spec.ts beside it: what
 * these tests assert is the SHAPE of the queries and the ORDER of the reads and writes. Whether the
 * engines then behave as intended is asked of real engines in tags.db-smoke.ts.
 */
const db = vi.hoisted(() => {
	const prisma = {
		transaction: {
			count: vi.fn()
		},
		transactionTag: {
			findMany: vi.fn(),
			createMany: vi.fn(),
			deleteMany: vi.fn()
		}
	};
	return { prisma };
});

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const mocks = vi.hoisted(() => ({
	forEachTransactionBatch: vi.fn(),
	resolveTagByName: vi.fn(),
	pruneOrphanTags: vi.fn()
}));

vi.mock('$lib/server/transactions/batch', () => ({
	forEachTransactionBatch: mocks.forEachTransactionBatch
}));

vi.mock('./service', () => ({
	resolveTagByName: mocks.resolveTagByName,
	pruneOrphanTags: mocks.pruneOrphanTags
}));

const { applyTagToFilteredSet, undoBulkTag, MAX_BULK_TAG_TRANSACTIONS } = await import('./bulk');
const { MAX_TRANSACTION_ID_FILTER } = await import('$lib/server/transactions/where');

const where = { userId: 'user-a' };

/** Drives forEachTransactionBatch's callback with `ids`, honouring an early `false`. */
function feedBatch(ids: string[]) {
	mocks.forEachTransactionBatch.mockImplementation(
		async (
			_where: unknown,
			_select: unknown,
			onBatch: (rows: Array<{ id: string }>) => void | false
		) => {
			onBatch(ids.map((id) => ({ id })));
		}
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolveTagByName.mockResolvedValue({ id: 'tag-1' });
	mocks.pruneOrphanTags.mockResolvedValue(0);
	db.prisma.transactionTag.findMany.mockResolvedValue([]);
	db.prisma.transactionTag.createMany.mockResolvedValue({ count: 0 });
	db.prisma.transactionTag.deleteMany.mockResolvedValue({ count: 0 });
	feedBatch(['tx-1', 'tx-2', 'tx-3']);
});

describe('the two caps', () => {
	it('asserts the bulk cap fits inside the undo payload cap', () => {
		expect.assertions(1);

		// Two constants with one asserted relation, following the precedent where.ts sets for
		// MAX_TRANSACTION_ID_FILTER and MAX_ANCHOR_IDS. How many rows one action may tag is a domain
		// fact; how many ids an undo payload's IN clause may carry is a property of the query layer.
		// If the bulk cap ever exceeded the id-filter cap, an undo would silently truncate and leave
		// rows tagged with no way back. The relation is what matters, not the equality.
		expect(MAX_BULK_TAG_TRANSACTIONS).toBeLessThanOrEqual(MAX_TRANSACTION_ID_FILTER);
	});
});

describe('applyTagToFilteredSet', () => {
	it('refuses rather than partially applying above the cap, and reports the matched count', async () => {
		expect.assertions(3);

		db.prisma.transaction.count.mockResolvedValue(300);

		const result = await applyTagToFilteredSet('user-a', where, 'Portugal');

		expect(result).toEqual({ outcome: 'too-many', matched: 300 });
		// Nothing written, and no tag created either: a refused action must leave no trace, or the
		// user retries into a state their first attempt already half-changed.
		expect(db.prisma.transactionTag.createMany).not.toHaveBeenCalled();
		expect(mocks.resolveTagByName).not.toHaveBeenCalled();
	});

	it('returns only the NEWLY linked ids, so an undo never untags a row that was already tagged', async () => {
		expect.assertions(2);

		db.prisma.transaction.count.mockResolvedValue(3);
		db.prisma.transactionTag.findMany.mockResolvedValue([{ transactionId: 'tx-1' }]);

		const result = await applyTagToFilteredSet('user-a', where, 'Portugal');

		// Narrow before reading: the return type is a discriminated union and linkedTransactionIds
		// exists only on the ok branch. Asserting the discriminant first is also what makes a silent
		// change to 'too-many' fail here rather than read as an empty list.
		expect(result.outcome).toBe('ok');
		if (result.outcome !== 'ok') return;
		expect(result.linkedTransactionIds).toEqual(['tx-2', 'tx-3']);
	});

	it('writes only the new links, never re-inserting one that exists', async () => {
		expect.assertions(1);

		db.prisma.transaction.count.mockResolvedValue(3);
		db.prisma.transactionTag.findMany.mockResolvedValue([{ transactionId: 'tx-1' }]);

		await applyTagToFilteredSet('user-a', where, 'Portugal');

		// Re-inserting an existing pair violates the composite primary key and would fail the whole
		// action. This is also what makes the error message's promise true: applying a tag twice is
		// a no-op rather than a duplicate.
		expect(db.prisma.transactionTag.createMany).toHaveBeenCalledWith({
			data: [
				{ transactionId: 'tx-2', tagId: 'tag-1' },
				{ transactionId: 'tx-3', tagId: 'tag-1' }
			]
		});
	});

	it('collects ids in batches rather than one unbounded findMany', async () => {
		expect.assertions(1);

		db.prisma.transaction.count.mockResolvedValue(3);

		await applyTagToFilteredSet('user-a', where, 'Portugal');

		expect(mocks.forEachTransactionBatch).toHaveBeenCalled();
	});

	it('reports ok with an empty list when every matching row already carries the tag', async () => {
		expect.assertions(2);

		db.prisma.transaction.count.mockResolvedValue(3);
		db.prisma.transactionTag.findMany.mockResolvedValue([
			{ transactionId: 'tx-1' },
			{ transactionId: 'tx-2' },
			{ transactionId: 'tx-3' }
		]);

		const result = await applyTagToFilteredSet('user-a', where, 'Portugal');

		expect(result.outcome).toBe('ok');
		// Not an error: the end state the user asked for is the state that already holds. And no
		// empty createMany, which some engines reject.
		expect(db.prisma.transactionTag.createMany).not.toHaveBeenCalled();
	});

	it('reports ok with an empty list when the filter matches nothing', async () => {
		expect.assertions(2);

		db.prisma.transaction.count.mockResolvedValue(0);
		feedBatch([]);

		const result = await applyTagToFilteredSet('user-a', where, 'Portugal');

		expect(result.outcome).toBe('ok');
		// No tag is created for an empty set. Otherwise a mistyped filter would leave a tag behind
		// that the auto-GC only reclaims on the next unlink, which never comes.
		expect(mocks.resolveTagByName).not.toHaveBeenCalled();
	});
});

describe('undoBulkTag', () => {
	it('scopes the undo through the transaction relation and by tag', async () => {
		expect.assertions(1);

		await undoBulkTag('user-a', 'tag-1', ['tx-1']);

		// TransactionTag carries no userId of its own, so the relation conjunct is the whole tenancy
		// guarantee here: without it a forged pair would delete another account's link.
		expect(db.prisma.transactionTag.deleteMany.mock.calls[0][0].where).toEqual({
			tagId: 'tag-1',
			transactionId: { in: ['tx-1'] },
			transaction: { userId: 'user-a' }
		});
	});

	it('is idempotent, so undoing twice removes nothing the second time', async () => {
		expect.assertions(2);

		db.prisma.transactionTag.deleteMany
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });

		expect(await undoBulkTag('user-a', 'tag-1', ['tx-1'])).toBe(1);
		expect(await undoBulkTag('user-a', 'tag-1', ['tx-1'])).toBe(0);
	});

	it('prunes the tag if the undo emptied it', async () => {
		expect.assertions(1);

		db.prisma.transactionTag.deleteMany.mockResolvedValue({ count: 1 });

		await undoBulkTag('user-a', 'tag-1', ['tx-1']);

		expect(mocks.pruneOrphanTags).toHaveBeenCalledWith('user-a', ['tag-1']);
	});

	it('does nothing at all for an empty id list', async () => {
		expect.assertions(2);

		expect(await undoBulkTag('user-a', 'tag-1', [])).toBe(0);
		// An empty `in` matches nothing, so the deleteMany would be harmless, but the prune that
		// follows it is not: it would delete a tag the user still has, having removed no link.
		expect(mocks.pruneOrphanTags).not.toHaveBeenCalled();
	});
});
