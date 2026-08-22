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
const { assignDedupeKeysForBatch } = await import('./dedupeRecompute');

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
			type
		}
	} as unknown as ImportedTransaction;
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

/** The bucket a run lands on, as `findImportBucketAccount` answers it. */
const BUCKET = {
	accountId: 'account-1',
	source: 'csv',
	currency: 'EUR',
	exponent: 2,
	providerAccountId: null
};

describe('describeIncomingBatch', () => {
	it('separates debits from credits as magnitudes, matching how persist.ts stores them', () => {
		const shape = describeIncomingBatch(JUNE, JUNE_PERIOD, BUCKET);
		expect(shape.transactionCount).toBe(3);
		expect(shape.debitCents).toBe(82185);
		expect(shape.creditCents).toBe(214000);
	});

	it('carries every deduplication key, because T3 is answered from them', () => {
		expect(describeIncomingBatch(JUNE, JUNE_PERIOD, BUCKET).dedupeKeys).toHaveLength(3);
	});

	it('builds the keys the write path would build, from the bucket the run lands on', () => {
		// The comparison this feeds asks "has this file already been through here", and it can
		// only answer that if the fingerprints it compares are the fingerprints the run would
		// store. Two constructions of the key is how the check and the write stop agreeing.
		expect(describeIncomingBatch(JUNE, JUNE_PERIOD, BUCKET).dedupeKeys).toEqual(
			assignDedupeKeysForBatch(JUNE, BUCKET)
		);
	});

	it('carries NO keys when the bucket does not exist yet, and that is exact rather than lenient', () => {
		// A bucket that does not exist holds no transactions, so no stored key can carry its id,
		// so a fingerprint comparison against it has nothing to find. Passing an empty list
		// computes the same verdict as passing keys that match nothing, which is what the T3 leg
		// below asserts.
		const shape = describeIncomingBatch(JUNE, JUNE_PERIOD, null);
		expect(shape.dedupeKeys).toEqual([]);
		// The other three terms are unchanged: the period and the totals do not depend on where
		// the rows land, so T1 and T2 still speak.
		expect(shape.transactionCount).toBe(3);
		expect(shape.debitCents).toBe(82185);
		expect(shape.creditCents).toBe(214000);
	});

	it('drops a row it cannot key rather than carrying a null into the comparison', () => {
		// A null in this list would be hashed and compared like a key, and every unkeyable row
		// would then look like the same row.
		const untyped = [
			{ ...JUNE[0], metadata: { ...JUNE[0].metadata, type: undefined } }
		] as unknown as ImportedTransaction[];
		expect(describeIncomingBatch(untyped, JUNE_PERIOD, BUCKET).dedupeKeys).toEqual([]);
	});
});

describe('findCollidingBatch', () => {
	it('fires when the periods overlap, the money matches and nothing is recognised', async () => {
		prismaMock.importBatch.findMany.mockResolvedValue([batchRow('b1', '2026-06-01', '2026-06-12')]);
		prismaMock.transaction.groupBy.mockResolvedValue(juneTotals('b1'));

		const found = await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD, BUCKET));

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

		expect(
			await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD, BUCKET))
		).toBeNull();
		// And it answered before aggregating anything, which is the reason it is checked first.
		expect(prismaMock.importBatch.findMany).not.toHaveBeenCalled();
	});

	it('T3 compares HASHES, never the raw keys', async () => {
		await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD, BUCKET));

		const where = prismaMock.transaction.count.mock.calls[0][0].where;
		expect(where.userId).toBe(USER);
		// Built from the same function the write path uses rather than from a field on the
		// transaction: the key is no longer carried on the row, it is derived from the row and
		// the bucket it is about to land in.
		expect(where.dedupeKeyHash.in).toEqual(
			assignDedupeKeysForBatch(JUNE, BUCKET).map((key) => computeDedupeKeyHash(key!))
		);
	});

	it('T1: asks the database for overlap, not for equality', async () => {
		// Asserted on the CLAUSE rather than on the answer. Prisma treats a missing clause as no
		// filter, so an implementation that dropped the period bounds would return the same answer
		// here and pass a test written the other way round.
		await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD, BUCKET));

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

		expect(
			await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD, BUCKET))
		).not.toBeNull();
	});

	it('T2: a monthly import with a few days of overlap does not fire', async () => {
		// The false positive the rule is judged on. The overlap is real, so T1 passes; the two runs
		// describe different money, so the counts and the sums differ and T2 refuses.
		prismaMock.importBatch.findMany.mockResolvedValue([batchRow('b1', '2026-05-08', '2026-06-05')]);
		prismaMock.transaction.groupBy.mockResolvedValue([
			{ importBatchId: 'b1', type: 'expense', _count: { _all: 22 }, _sum: { amountCents: 190855 } },
			{ importBatchId: 'b1', type: 'income', _count: { _all: 1 }, _sum: { amountCents: 223500 } }
		]);

		expect(
			await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD, BUCKET))
		).toBeNull();
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

		expect(
			await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD, BUCKET))
		).toBeNull();
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

		expect(
			await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD, BUCKET))
		).toBeNull();
	});

	it('a batch with no transactions of its own never matches', async () => {
		prismaMock.importBatch.findMany.mockResolvedValue([batchRow('b1', '2026-06-01', '2026-06-12')]);
		prismaMock.transaction.groupBy.mockResolvedValue([]);

		expect(
			await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD, BUCKET))
		).toBeNull();
	});

	it('a run with no period asks the database nothing at all', async () => {
		const undated = describeIncomingBatch(JUNE, { from: null, to: null }, BUCKET);

		expect(await findCollidingBatch(USER, undated)).toBeNull();
		expect(prismaMock.transaction.count).not.toHaveBeenCalled();
		expect(prismaMock.importBatch.findMany).not.toHaveBeenCalled();
	});
});

describe('findCollidingBatch with excludeBatchId', () => {
	/**
	 * The batches the query would return, with the ONE predicate these tests are about applied.
	 *
	 * The mock elsewhere in this file ignores the WHERE clause entirely, which is right for the
	 * period terms because those tests assert the clause that was sent. It is wrong here: an
	 * exclusion expressed as a clause and answered by a mock that ignores clauses is invisible, so
	 * a test written on the return value alone would pass before the code existed.
	 *
	 * So this models `id: { not }` and nothing else. Modelling it faithfully includes modelling its
	 * ABSENCE, which is the part that is easy to get wrong: Prisma treats a missing clause as no
	 * filter, so no `id` clause must filter nothing rather than everything.
	 */
	function givenBatches(...rows: ReturnType<typeof batchRow>[]) {
		prismaMock.importBatch.findMany.mockImplementation(
			async ({ where }: { where: { id?: { not?: string } } }) =>
				rows.filter((row) => row.id !== where.id?.not)
		);
	}

	it('does not report the excluded batch even when every figure matches', async () => {
		// The batch a correction is replacing. Its period, its count and its totals match by
		// construction, because it is the same statement read a different way, so this is the one
		// firing that says nothing and blocks the repair the user came for.
		givenBatches(batchRow('batch-old', '2026-06-01', '2026-06-12'));
		prismaMock.transaction.groupBy.mockResolvedValue(juneTotals('batch-old'));

		const found = await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD, BUCKET), {
			excludeBatchId: 'batch-old'
		});

		expect(found).toBeNull();
	});

	it('still reports a DIFFERENT batch that matches, so the exclusion is not a silencer', async () => {
		// The case that must survive: a genuine earlier import of the same statement, which this
		// correction is not replacing. The two fixtures differ ONLY in the batch id, because one
		// that also moved the period would pass with the exclusion removed.
		givenBatches(
			batchRow('batch-old', '2026-06-01', '2026-06-12'),
			batchRow('batch-other', '2026-06-01', '2026-06-12')
		);
		prismaMock.transaction.groupBy.mockResolvedValue([
			...juneTotals('batch-old'),
			...juneTotals('batch-other')
		]);

		const found = await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD, BUCKET), {
			excludeBatchId: 'batch-old'
		});

		expect(found?.batchId).toBe('batch-other');
	});

	it('excludes in the QUERY, and sends no id clause when nothing is excluded', async () => {
		// Asserted on the clause for the reason the T1 test states: the two tests above are answered
		// by a mock that models this predicate, so they pass just as well against an exclusion
		// applied in JavaScript after the query. Only the clause tells them apart. The second half
		// is the direction that matters more: `id: { not: undefined }` sent on every ordinary import
		// would be a filter nobody asked for.
		givenBatches(batchRow('batch-old', '2026-06-01', '2026-06-12'));

		await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD, BUCKET), {
			excludeBatchId: 'batch-old'
		});
		expect(prismaMock.importBatch.findMany.mock.calls[0][0].where.id).toEqual({
			not: 'batch-old'
		});

		await findCollidingBatch(USER, describeIncomingBatch(JUNE, JUNE_PERIOD, BUCKET));
		expect(prismaMock.importBatch.findMany.mock.calls[1][0].where).not.toHaveProperty('id');
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
