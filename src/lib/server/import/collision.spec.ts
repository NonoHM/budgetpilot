import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDedupeKeyHash } from './dedupeKey';
import type { ImportedTransaction } from './types';

/**
 * The collision rule, term by term.
 *
 * Prisma is mocked with plain `vi.fn()`s rather than an in-memory fake, so each test states which
 * call happened with which arguments. That matters more here than usual: two of the three terms are
 * expressed as a WHERE clause, and Prisma treats a missing clause as no filter. A fake that silently
 * ignored `periodStart` would make every period test pass, so the period test asserts the clause
 * that was sent rather than only the answer that came back.
 */
const prismaMock = vi.hoisted(() => ({
	transaction: {
		count: vi.fn(),
		groupBy: vi.fn()
	},
	importBatch: {
		findMany: vi.fn()
	}
}));
vi.mock('$lib/server/db', () => ({ prisma: prismaMock }));

const { describeIncomingBatch, findCollidingBatch, findCollidingPairs } =
	await import('./collision');

const USER = 'user-1';

function transaction(
	date: string,
	label: string,
	amountCents: number,
	type: 'income' | 'expense'
): ImportedTransaction {
	return {
		date,
		label,
		amountCents,
		category: 'Non classé',
		metadata: {
			reference: '',
			notes: '',
			type,
			deduplicationKey: `${date}|${label}|${Math.abs(amountCents)}|${type}|0|`
		}
	} as ImportedTransaction;
}

/** June, three rows: two debits and one credit. The shape every test below varies from. */
const JUNE = [
	transaction('2026-06-01', 'loyer', 78000, 'expense'),
	transaction('2026-06-06', 'salaire', 214000, 'income'),
	transaction('2026-06-12', 'courses', 4185, 'expense')
];
const JUNE_PERIOD = { from: '2026-06-01', to: '2026-06-12' };

function batchRow(id: string, from: string, to: string) {
	return {
		id,
		fileName: `${id}.csv`,
		createdAt: new Date('2026-06-30T10:00:00.000Z'),
		periodStart: new Date(`${from}T00:00:00.000Z`),
		periodEnd: new Date(`${to}T00:00:00.000Z`)
	};
}

/** What `groupBy(['importBatchId', 'type'])` returns for a batch holding the JUNE figures. */
function juneTotals(batchId: string) {
	return [
		{
			importBatchId: batchId,
			type: 'expense',
			_count: { _all: 2 },
			_sum: { amountCents: 82185 }
		},
		{ importBatchId: batchId, type: 'income', _count: { _all: 1 }, _sum: { amountCents: 214000 } }
	];
}

beforeEach(() => {
	vi.clearAllMocks();
	prismaMock.transaction.count.mockResolvedValue(0);
	prismaMock.importBatch.findMany.mockResolvedValue([]);
	prismaMock.transaction.groupBy.mockResolvedValue([]);
});

describe('describeIncomingBatch', () => {
	it('separates debits from credits as magnitudes, matching how persist.ts stores them', () => {
		const shape = describeIncomingBatch(JUNE, JUNE_PERIOD);
		expect(shape.transactionCount).toBe(3);
		expect(shape.debitCents).toBe(82185);
		expect(shape.creditCents).toBe(214000);
	});

	it('carries every deduplication key, because T3 is answered from them', () => {
		expect(describeIncomingBatch(JUNE, JUNE_PERIOD).dedupeKeys).toHaveLength(3);
	});
});

describe('findCollidingBatch', () => {
	it('fires when the periods overlap, the money matches and nothing is recognised', async () => {
		prismaMock.importBatch.findMany.mockResolvedValue([batchRow('b1', '2026-06-01', '2026-06-12')]);
		prismaMock.transaction.groupBy.mockResolvedValue(juneTotals('b1'));

		const found = await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD));

		expect(found?.batchId).toBe('b1');
		expect(found?.transactionCount).toBe(3);
		expect(found?.debitCents).toBe(82185);
		expect(found?.creditCents).toBe(214000);
	});

	it('T3: stays silent when even one incoming fingerprint already exists', async () => {
		// The ordinary re-import of a file already imported. Deduplication reports every row as a
		// duplicate on its own, so a warning here is a warning shown on a harmless action, which is
		// how a warning stops being read. THIS is the term that decides the false-positive rate.
		prismaMock.transaction.count.mockResolvedValue(1);
		prismaMock.importBatch.findMany.mockResolvedValue([batchRow('b1', '2026-06-01', '2026-06-12')]);
		prismaMock.transaction.groupBy.mockResolvedValue(juneTotals('b1'));

		expect(await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD))).toBeNull();
		// And it answered before aggregating anything, which is the reason it is checked first.
		expect(prismaMock.importBatch.findMany).not.toHaveBeenCalled();
	});

	it('T3 compares HASHES, never the raw keys', async () => {
		await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD));

		const where = prismaMock.transaction.count.mock.calls[0][0].where;
		expect(where.userId).toBe(USER);
		expect(where.dedupeKeyHash.in).toEqual(
			JUNE.map((row) => computeDedupeKeyHash(row.metadata.deduplicationKey))
		);
	});

	it('T1: asks the database for overlap, not for equality', async () => {
		// Asserted on the CLAUSE rather than on the answer. Prisma treats a missing clause as no
		// filter, so an implementation that dropped the period bounds would return the same answer
		// here and pass a test written the other way round.
		await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD));

		const where = prismaMock.importBatch.findMany.mock.calls[0][0].where;
		expect(where.userId).toBe(USER);
		expect(where.periodStart.lte).toEqual(new Date('2026-06-12T00:00:00.000Z'));
		expect(where.periodEnd.gte).toEqual(new Date('2026-06-01T00:00:00.000Z'));
	});

	it('T1: a shifted date column still overlaps, which exact matching would have missed', async () => {
		// Re-designating the DATE role moves the period. The batch below starts and ends a day later
		// than the incoming run, so an equality test would find nothing on exactly the run this
		// mechanism exists for.
		prismaMock.importBatch.findMany.mockResolvedValue([batchRow('b1', '2026-06-02', '2026-06-13')]);
		prismaMock.transaction.groupBy.mockResolvedValue(juneTotals('b1'));

		expect(await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD))).not.toBeNull();
	});

	it('T2: a monthly import with a few days of overlap does not fire', async () => {
		// The false positive the rule is judged on. The overlap is real, so T1 passes; the two runs
		// describe different money, so the counts and the sums differ and T2 refuses.
		prismaMock.importBatch.findMany.mockResolvedValue([batchRow('b1', '2026-05-08', '2026-06-05')]);
		prismaMock.transaction.groupBy.mockResolvedValue([
			{ importBatchId: 'b1', type: 'expense', _count: { _all: 22 }, _sum: { amountCents: 190855 } },
			{ importBatchId: 'b1', type: 'income', _count: { _all: 1 }, _sum: { amountCents: 223500 } }
		]);

		expect(await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD))).toBeNull();
	});

	it('T2: both sums separately, so an equal NET is not accepted as equal money', async () => {
		// The fixture is chosen to distinguish, not to read well. Same transaction count and the same
		// net (131 815 either way), because both sums are 100 euros larger: a rule comparing the net
		// fires here and calls two different statements the same one. An earlier version of this test
		// varied the counts too, so the count check answered first and the sums were never reached.
		prismaMock.importBatch.findMany.mockResolvedValue([batchRow('b1', '2026-06-01', '2026-06-12')]);
		prismaMock.transaction.groupBy.mockResolvedValue([
			{ importBatchId: 'b1', type: 'expense', _count: { _all: 2 }, _sum: { amountCents: 92185 } },
			{ importBatchId: 'b1', type: 'income', _count: { _all: 1 }, _sum: { amountCents: 224000 } }
		]);

		expect(await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD))).toBeNull();
	});

	it('T2: the COUNT is compared too, so equal sums over a different number of rows do not fire', async () => {
		// Isolates the count from the sums. Both sums match to the cent and the batch holds one row
		// more, which is what a statement that split one payment into two looks like. Without the
		// count term nothing here separates the two, and every other fixture in this file happens to
		// differ in the sums as well, so none of them would have noticed its removal.
		prismaMock.importBatch.findMany.mockResolvedValue([batchRow('b1', '2026-06-01', '2026-06-12')]);
		prismaMock.transaction.groupBy.mockResolvedValue([
			{ importBatchId: 'b1', type: 'expense', _count: { _all: 3 }, _sum: { amountCents: 82185 } },
			{ importBatchId: 'b1', type: 'income', _count: { _all: 1 }, _sum: { amountCents: 214000 } }
		]);

		expect(await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD))).toBeNull();
	});

	it('a batch with no transactions of its own never matches', async () => {
		prismaMock.importBatch.findMany.mockResolvedValue([batchRow('b1', '2026-06-01', '2026-06-12')]);
		prismaMock.transaction.groupBy.mockResolvedValue([]);

		expect(await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD))).toBeNull();
	});

	it('a run with no period asks the database nothing at all', async () => {
		const undated = describeIncomingBatch(JUNE, { from: null, to: null });

		expect(await findCollidingBatch(USER, undated)).toBeNull();
		expect(prismaMock.transaction.count).not.toHaveBeenCalled();
		expect(prismaMock.importBatch.findMany).not.toHaveBeenCalled();
	});
});

describe('findCollidingPairs', () => {
	it('pairs two stored batches that agree on period, count and both sums', async () => {
		prismaMock.importBatch.findMany.mockResolvedValue([
			batchRow('b1', '2026-06-01', '2026-06-12'),
			batchRow('b2', '2026-06-01', '2026-06-12')
		]);
		prismaMock.transaction.groupBy.mockResolvedValue([...juneTotals('b1'), ...juneTotals('b2')]);

		const pairs = await findCollidingPairs(USER);

		expect(pairs).toHaveLength(1);
		expect([pairs[0].first.batchId, pairs[0].second.batchId]).toEqual(['b1', 'b2']);
	});

	it('ignores a re-import deduplication absorbed, because it materialised no rows', async () => {
		// The legitimate case, and the reason T3 is not needed backwards: the unique constraint on
		// (userId, dedupeKeyHash) makes every pair of batches disjoint by construction, so "no shared
		// fingerprint" separates nothing. A fully absorbed re-import excludes itself instead by
		// holding zero transactions, which can never equal the original's count.
		prismaMock.importBatch.findMany.mockResolvedValue([
			batchRow('b1', '2026-06-01', '2026-06-12'),
			batchRow('b2', '2026-06-01', '2026-06-12')
		]);
		prismaMock.transaction.groupBy.mockResolvedValue(juneTotals('b1'));

		expect(await findCollidingPairs(USER)).toEqual([]);
	});

	it('does not pair two months that merely hold identical figures', async () => {
		prismaMock.importBatch.findMany.mockResolvedValue([
			batchRow('b1', '2026-05-01', '2026-05-31'),
			batchRow('b2', '2026-06-01', '2026-06-30')
		]);
		prismaMock.transaction.groupBy.mockResolvedValue([...juneTotals('b1'), ...juneTotals('b2')]);

		expect(await findCollidingPairs(USER)).toEqual([]);
	});

	it('reads nothing further when the user has fewer than two batches', async () => {
		prismaMock.importBatch.findMany.mockResolvedValue([batchRow('b1', '2026-06-01', '2026-06-12')]);

		expect(await findCollidingPairs(USER)).toEqual([]);
		expect(prismaMock.transaction.groupBy).not.toHaveBeenCalled();
	});
});
