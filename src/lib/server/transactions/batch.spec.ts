import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
	id: string;
	date: Date;
	label: string;
}

const db = vi.hoisted(() => {
	const rows: Row[] = [];

	return {
		rows,
		prisma: {
			transaction: {
				// Faithful cursor-paginated findMany: sorts by (date desc, id desc) — the exact
				// order forEachTransactionBatch always requests — then applies cursor+skip / take,
				// mirroring real Prisma semantics closely enough to test the scan loop itself.
				findMany: vi.fn(
					async ({
						where,
						orderBy,
						cursor,
						skip,
						take
					}: {
						where?: { userId?: string };
						orderBy?: Array<Record<string, 'asc' | 'desc'>>;
						cursor?: { id: string };
						skip?: number;
						take?: number;
					}) => {
						void where;
						let result = [...rows].sort((a, b) => {
							for (const clause of orderBy ?? []) {
								const [field, dir] = Object.entries(clause)[0] as [keyof Row, 'asc' | 'desc'];
								const av = a[field];
								const bv = b[field];
								let cmp = 0;
								if (av instanceof Date && bv instanceof Date) cmp = av.getTime() - bv.getTime();
								else if (av! < bv!) cmp = -1;
								else if (av! > bv!) cmp = 1;
								if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
							}
							return 0;
						});
						if (cursor) {
							const idx = result.findIndex((r) => r.id === cursor.id);
							result = idx === -1 ? [] : result.slice(idx + (skip ?? 0));
						}
						if (typeof take === 'number') result = result.slice(0, take);
						return result;
					}
				)
			}
		}
	};
});

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { forEachTransactionBatch } = await import('./batch');

function makeRows(count: number): Row[] {
	// Distinct dates (descending as index grows) with zero-padded ids so (date desc, id desc)
	// gives a single deterministic total order — makes the expected scan order trivial to assert.
	return Array.from({ length: count }, (_, i) => ({
		id: `tx-${String(count - i).padStart(6, '0')}`,
		date: new Date(2026, 0, count - i),
		label: `Transaction ${i}`
	}));
}

describe('forEachTransactionBatch', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.rows.length = 0;
	});

	it('scans every row across several batches when batchSize forces multiple iterations', async () => {
		expect.assertions(3);

		db.rows.push(...makeRows(11));
		const seen: string[] = [];

		await forEachTransactionBatch(
			{ userId: 'user-a' },
			{ id: true },
			(rows) => {
				seen.push(...rows.map((r) => r.id));
			},
			3
		);

		expect(seen).toHaveLength(11);
		expect(new Set(seen).size).toBe(11); // no duplicates across batch boundaries
		expect(db.prisma.transaction.findMany).toHaveBeenCalledTimes(4); // ceil(11/3)
	});

	it('never requests more than batchSize rows per call', async () => {
		expect.assertions(1);

		db.rows.push(...makeRows(11));
		const batchSize = 3;

		await forEachTransactionBatch({ userId: 'user-a' }, { id: true }, () => {}, batchSize);

		const calls = db.prisma.transaction.findMany.mock.calls as Array<[{ take: number }]>;
		expect(calls.every(([args]) => args.take === batchSize)).toBe(true);
	});

	it('stops scanning as soon as onBatch returns false, without requesting further batches', async () => {
		expect.assertions(2);

		db.rows.push(...makeRows(11));
		const seenBatches: string[][] = [];

		await forEachTransactionBatch(
			{ userId: 'user-a' },
			{ id: true },
			(rows) => {
				seenBatches.push(rows.map((r) => r.id));
				if (seenBatches.length === 2) return false;
			},
			3
		);

		expect(seenBatches).toHaveLength(2);
		expect(db.prisma.transaction.findMany).toHaveBeenCalledTimes(2);
	});

	it('preserves the stable (date desc, id desc) order across batch boundaries', async () => {
		expect.assertions(1);

		db.rows.push(...makeRows(10));
		const seen: string[] = [];

		await forEachTransactionBatch(
			{ userId: 'user-a' },
			{ id: true },
			(rows) => {
				seen.push(...rows.map((r) => r.id));
			},
			4
		);

		// makeRows generates ids tx-000010 (most recent date) down to tx-000001 (oldest).
		const expectedOrder = Array.from(
			{ length: 10 },
			(_, i) => `tx-${String(10 - i).padStart(6, '0')}`
		);
		expect(seen).toEqual(expectedOrder);
	});

	it('calls onBatch exactly once with an empty result set skipped (returns immediately) when there is nothing to scan', async () => {
		expect.assertions(2);

		const onBatch = vi.fn();
		await forEachTransactionBatch({ userId: 'user-a' }, { id: true }, onBatch, 5);

		expect(onBatch).not.toHaveBeenCalled();
		expect(db.prisma.transaction.findMany).toHaveBeenCalledTimes(1);
	});

	it('advances the cursor to the last row id of the previous batch, with skip: 1 (excludes it from the next page)', async () => {
		expect.assertions(1);

		// 7 rows, batchSize 3 -> batches of ids [000007..000005], [000004..000002], [000001]
		// (id desc order, see makeRows): the cursor must be the last id of the PREVIOUS batch.
		db.rows.push(...makeRows(7));

		await forEachTransactionBatch({ userId: 'user-a' }, { id: true }, () => {}, 3);

		const calls = db.prisma.transaction.findMany.mock.calls as Array<
			[{ cursor?: { id: string }; skip?: number }]
		>;
		expect(calls.map(([args]) => ({ cursor: args.cursor, skip: args.skip }))).toEqual([
			{ cursor: undefined, skip: undefined },
			{ cursor: { id: 'tx-000005' }, skip: 1 },
			{ cursor: { id: 'tx-000002' }, skip: 1 }
		]);
	});
});
