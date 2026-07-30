import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../database/types.ts';
import { hasPendingDedupeKeyHashes, runDedupeKeyHashBackfill } from './dedupeBackfill';
import { computeDedupeKeyHash } from './dedupeKey';

interface Row {
	id: string;
	dedupeKey: string | null;
	dedupeKeyHash: string | null;
}

/**
 * In-memory stand-in for the calls the backfill makes. Faithful on the parts that decide
 * correctness: the "still missing its hash" filter, the batch size, and id-scoped writes.
 */
function buildDb(rows: Row[]) {
	const table = {
		findMany: vi.fn(async ({ take }: { take?: number } = {}) => {
			const pending = rows
				.filter((row) => row.dedupeKey !== null && row.dedupeKeyHash === null)
				.sort((left, right) => left.id.localeCompare(right.id));
			return pending.slice(0, take).map((row) => ({ id: row.id, dedupeKey: row.dedupeKey }));
		}),
		count: vi.fn(
			async ({ where }: { where?: { id?: { in: string[] } } } = {}) =>
				rows.filter(
					(row) =>
						row.dedupeKey !== null &&
						row.dedupeKeyHash === null &&
						(!where?.id || where.id.in.includes(row.id))
				).length
		),
		findFirst: vi.fn(
			async () => rows.find((row) => row.dedupeKey !== null && row.dedupeKeyHash === null) ?? null
		),
		updateMany: vi.fn(
			async ({
				where,
				data
			}: {
				where: { id: { in: string[] } };
				data: { dedupeKeyHash: string };
			}) => {
				let count = 0;
				for (const row of rows) {
					if (!where.id.in.includes(row.id)) continue;
					row.dedupeKeyHash = data.dedupeKeyHash;
					count += 1;
				}
				return { count };
			}
		)
	};

	const prisma = {
		transaction: table,
		$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
			callback({ transaction: table })
		)
	};

	return { rows, table, prisma: prisma as unknown as PrismaClient };
}

function row(id: string, dedupeKey: string | null, dedupeKeyHash: string | null = null): Row {
	return { id, dedupeKey, dedupeKeyHash };
}

describe('runDedupeKeyHashBackfill', () => {
	let db: ReturnType<typeof buildDb>;

	beforeEach(() => {
		db = buildDb([
			row('t-1', '2026-06-01|carrefour|-4210|expense||'),
			row('t-2', '2026-06-02|café|-350|expense||'),
			row('t-3', null),
			row('t-4', '2026-06-03|salaire|250050|income||', 'already-hashed')
		]);
	});

	it('hashes every row still missing its hash', async () => {
		expect.assertions(3);

		const written = await runDedupeKeyHashBackfill({ prisma: db.prisma });

		expect(written).toBe(2);
		expect(db.rows[0].dedupeKeyHash).toBe(computeDedupeKeyHash(db.rows[0].dedupeKey!));
		expect(db.rows[1].dedupeKeyHash).toBe(computeDedupeKeyHash(db.rows[1].dedupeKey!));
	});

	it('leaves a row without a deduplication key alone', async () => {
		expect.assertions(1);

		await runDedupeKeyHashBackfill({ prisma: db.prisma });

		// No key means no identity to compare, not an empty one: hashing "" would make every
		// keyless row a duplicate of every other.
		expect(db.rows[2].dedupeKeyHash).toBeNull();
	});

	it('never rewrites a hash that is already there', async () => {
		expect.assertions(1);

		await runDedupeKeyHashBackfill({ prisma: db.prisma });

		expect(db.rows[3].dedupeKeyHash).toBe('already-hashed');
	});

	it('writes by id, never by re-matching the raw key', async () => {
		expect.assertions(1);

		await runDedupeKeyHashBackfill({ prisma: db.prisma });

		// Matching the raw key in SQL is the very comparison this column exists to replace,
		// so the backfill must not depend on it either.
		const wheres = db.table.updateMany.mock.calls.map(([args]) => args.where);
		expect(wheres.every((where) => 'id' in where && !('dedupeKey' in where))).toBe(true);
	});

	describe('idempotency', () => {
		it('changes nothing on a second run', async () => {
			expect.assertions(2);

			await runDedupeKeyHashBackfill({ prisma: db.prisma });
			const afterFirst = JSON.stringify(db.rows);

			const written = await runDedupeKeyHashBackfill({ prisma: db.prisma });

			expect(written).toBe(0);
			expect(JSON.stringify(db.rows)).toBe(afterFirst);
		});

		it('reports nothing left to do once it has run', async () => {
			expect.assertions(2);

			expect(await hasPendingDedupeKeyHashes(db.prisma)).toBe(true);

			await runDedupeKeyHashBackfill({ prisma: db.prisma });

			// The gate the boot path uses, so a migrated install skips the scan entirely.
			expect(await hasPendingDedupeKeyHashes(db.prisma)).toBe(false);
		});
	});

	it('stops with an error instead of spinning if a pass writes nothing', async () => {
		expect.assertions(1);

		// Termination rests on every pass shrinking the pending set. A write that silently
		// applies to no row would otherwise return the same page forever, at boot.
		db.table.updateMany.mockResolvedValue({ count: 0 });

		await expect(runDedupeKeyHashBackfill({ prisma: db.prisma })).rejects.toThrow(/stalled/);
	});

	it('keeps going when a pass writes nothing because the rows are no longer pending', async () => {
		expect.assertions(1);

		// A row can legitimately disappear between the read and the write (a concurrent delete,
		// a restore), and MySQL reports zero affected rows when an update sets a value the row
		// already holds. Neither is a stall, and this runs at boot, where the difference decides
		// whether the app starts at all.
		db.table.updateMany.mockImplementationOnce(async () => {
			for (const item of db.rows) {
				if (item.dedupeKey !== null && item.dedupeKeyHash === null) item.dedupeKeyHash = 'set';
			}
			return { count: 0 };
		});

		// What matters is that it finishes rather than refusing to boot. How many rows it counts
		// as written on the way through is incidental.
		await expect(runDedupeKeyHashBackfill({ prisma: db.prisma })).resolves.toBeTypeOf('number');
	});

	it('walks past the first page instead of re-reading it forever', async () => {
		expect.assertions(2);

		// 1200 rows against a 1000-row read batch. This caught the first implementation, which
		// paginated with a cursor: a written row leaves the filter, so the cursor pointed at a
		// row the next query no longer returned and the walk stopped after one page, leaving 200
		// rows unhashed and invisible to every future duplicate check.
		const many = buildDb(
			Array.from({ length: 1200 }, (_, index) =>
				row(`t-${String(index).padStart(4, '0')}`, `key-${index}`)
			)
		);

		const written = await runDedupeKeyHashBackfill({ prisma: many.prisma });

		expect(written).toBe(1200);
		expect(many.rows.every((item) => item.dedupeKeyHash !== null)).toBe(true);
	});
});
