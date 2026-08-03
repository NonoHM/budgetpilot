import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	prisma: { transactionTag: { groupBy: vi.fn() } }
}));
vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

import { countTagsInScope } from './counts';

beforeEach(() => vi.resetAllMocks());

describe('countTagsInScope', () => {
	it('scopes by userId on BOTH sides of the link, because TransactionTag carries no userId', async () => {
		expect.assertions(2);
		db.prisma.transactionTag.groupBy.mockResolvedValue([]);
		// NOTE the `where` deliberately carries NO userId. The first version of this test passed one
		// in and then asserted it came back out, which is an assertion about the fixture rather than
		// about the code: it passed for any implementation that forwards `where` verbatim — which is
		// precisely what the function did, applying userId to the tag side alone. Half of what the
		// docstring calls "the ENTIRE protection" was whatever the caller happened to supply.
		await countTagsInScope('user-1', { type: 'expense' });
		const arg = db.prisma.transactionTag.groupBy.mock.calls[0][0];
		expect(arg.where.transaction).toMatchObject({ userId: 'user-1' });
		expect(arg.where.tag).toMatchObject({ userId: 'user-1' });
	});

	it('a caller-supplied userId cannot override the scoping one', async () => {
		expect.assertions(1);
		db.prisma.transactionTag.groupBy.mockResolvedValue([]);
		await countTagsInScope('user-1', { userId: 'someone-else' });
		const arg = db.prisma.transactionTag.groupBy.mock.calls[0][0];
		// Spread order is the mechanism: userId goes last, so it can only ever narrow.
		expect(arg.where.transaction.userId).toBe('user-1');
	});

	it('chunks a large id set and sums the per-tag counts instead of giving up', async () => {
		expect.assertions(3);
		// 600 ids across three chunks of 250. Unbounded, this became a single IN() as long as the
		// whole matched set; SQLite caps host parameters, the caller swallowed the resulting error,
		// and the user silently got "comptes indisponibles" for good.
		const ids = Array.from({ length: 600 }, (_, i) => `tx-${i}`);
		db.prisma.transactionTag.groupBy.mockResolvedValue([{ tagId: 't1', _count: { _all: 4 } }]);

		const result = await countTagsInScope('user-1', { userId: 'user-1' }, ids);

		expect(db.prisma.transactionTag.groupBy).toHaveBeenCalledTimes(3);
		const sizes = db.prisma.transactionTag.groupBy.mock.calls.map(
			(call) => call[0].where.transaction.id.in.length
		);
		expect(sizes).toEqual([250, 250, 100]);
		// Chunks partition a set of distinct ids, so summing is exact rather than approximate.
		expect(result).toEqual([{ tagId: 't1', count: 12 }]);
	});

	it('an empty matched set counts nothing, without querying', async () => {
		expect.assertions(2);
		const result = await countTagsInScope('user-1', { userId: 'user-1' }, []);
		expect(result).toEqual([]);
		expect(db.prisma.transactionTag.groupBy).not.toHaveBeenCalled();
	});

	it('counts inside the caller-supplied scope, not globally', async () => {
		expect.assertions(1);
		db.prisma.transactionTag.groupBy.mockResolvedValue([]);
		await countTagsInScope('user-1', { userId: 'user-1', categoryId: 'cat-9' });
		const arg = db.prisma.transactionTag.groupBy.mock.calls[0][0];
		// The whole filter reaches the query. A global count here is the "filter that returns
		// nothing" the design exists to prevent.
		expect(arg.where.transaction).toMatchObject({ userId: 'user-1', categoryId: 'cat-9' });
	});

	it('maps groupBy rows to {tagId, count}', async () => {
		expect.assertions(1);
		db.prisma.transactionTag.groupBy.mockResolvedValue([
			{ tagId: 't1', _count: { _all: 3 } },
			{ tagId: 't2', _count: { _all: 0 } }
		]);
		const result = await countTagsInScope('user-1', { userId: 'user-1' });
		expect(result).toEqual([
			{ tagId: 't1', count: 3 },
			{ tagId: 't2', count: 0 }
		]);
	});
});
