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
		await countTagsInScope('user-1', { userId: 'user-1', type: 'expense' });
		const arg = db.prisma.transactionTag.groupBy.mock.calls[0][0];
		expect(arg.where.transaction).toMatchObject({ userId: 'user-1' });
		expect(arg.where.tag).toMatchObject({ userId: 'user-1' });
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
