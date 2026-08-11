import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../database/types.ts';
import { hasPendingNameKeys, runNameKeyBackfill } from './backfill';
import { computeNameKey } from './nameKey';

/**
 * In-memory stand-in for the handful of Prisma calls the backfill makes.
 *
 * Faithful where it matters: `updateMany`/`deleteMany` apply the same `userId` scoping the
 * real client would, so a test that forgot to scope a write would show up as one user's rows
 * disappearing from another user's data.
 */
interface Row {
	id: string;
	userId: string;
	createdAt: Date;
	updatedAt: Date;
	[field: string]: unknown;
}

/** Resolves a relation named in a `where` to the parent row it points at, or null. */
type RelationResolver = (field: string, row: Row) => Row | null;

function matches(
	row: Row,
	where: Record<string, unknown> | undefined,
	resolveRelation?: RelationResolver
): boolean {
	if (!where) return true;
	return Object.entries(where).every(([field, expected]) => {
		const actual = row[field];
		if (expected && typeof expected === 'object' && 'in' in expected) {
			return (expected as { in: unknown[] }).in.includes(actual);
		}
		if (expected && typeof expected === 'object' && 'not' in expected) {
			return actual !== (expected as { not: unknown }).not;
		}
		if (expected && typeof expected === 'object') {
			// A relation filter — `transaction: { userId }` on TransactionSplit is the only one the
			// backfill issues. Resolved against the real parent rows rather than skipped, because
			// TransactionSplit carries no userId of its own and this conjunct IS its tenancy scope: a
			// fake that ignored it would report an unscoped cross-tenant write as correctly scoped.
			const parent = resolveRelation?.(field, row);
			if (!parent) return false;
			return matches(parent, expected as Record<string, unknown>, resolveRelation);
		}
		return actual === expected;
	});
}

type Where = Record<string, unknown>;

interface QueryArgs {
	where?: Where;
	data?: Record<string, unknown>;
	distinct?: string[];
	select?: Record<string, boolean>;
	by?: string[];
}

function table(rows: Row[], resolveRelation?: RelationResolver) {
	return {
		rows,
		findMany: vi.fn(async ({ where, distinct, select }: QueryArgs = {}) => {
			let result = rows.filter((row) => matches(row, where, resolveRelation));
			if (distinct) {
				const seen = new Set<unknown>();
				result = result.filter((row) => {
					const value = row[distinct[0]];
					if (seen.has(value)) return false;
					seen.add(value);
					return true;
				});
			}
			return result.map((row) => (select ? pick(row, Object.keys(select)) : { ...row }));
		}),
		count: vi.fn(
			async ({ where }: QueryArgs = {}) =>
				rows.filter((row) => matches(row, where, resolveRelation)).length
		),
		updateMany: vi.fn(async ({ where, data }: QueryArgs) => {
			let count = 0;
			for (const row of rows) {
				if (!matches(row, where, resolveRelation)) continue;
				Object.assign(row, data);
				count += 1;
			}
			return { count };
		}),
		deleteMany: vi.fn(async ({ where }: QueryArgs) => {
			let count = 0;
			for (let index = rows.length - 1; index >= 0; index--) {
				if (!matches(rows[index], where, resolveRelation)) continue;
				rows.splice(index, 1);
				count += 1;
			}
			return { count };
		}),
		groupBy: vi.fn(async ({ by, where }: QueryArgs) => {
			const field = by?.[0] ?? 'id';
			const counts = new Map<unknown, number>();
			for (const row of rows.filter((item) => matches(item, where, resolveRelation))) {
				const value = row[field];
				counts.set(value, (counts.get(value) ?? 0) + 1);
			}
			return [...counts].map(([value, total]) => ({ [field]: value, _count: { _all: total } }));
		})
	};
}

function pick(row: Row, fields: string[]): Record<string, unknown> {
	return Object.fromEntries(fields.map((field) => [field, row[field]]));
}

const OLD = new Date('2026-01-01T00:00:00.000Z');
const NEW = new Date('2026-06-01T00:00:00.000Z');

function row(overrides: Partial<Row> & { id: string; userId: string }): Row {
	return { createdAt: OLD, updatedAt: OLD, ...overrides } as Row;
}

function buildDb() {
	// Built before `tables` so the split table's relation resolver can close over it by name. Held
	// inside `tables` too — the two are the same array, so a write through either is visible to both.
	const transactionRows = [
		row({
			id: 'tx-1',
			userId: 'user-a',
			categoryId: 'cat-new',
			accountId: 'acc-1',
			manualCategory: 'Courses',
			manualCategoryKey: null
		}),
		row({
			id: 'tx-2',
			userId: 'user-a',
			categoryId: 'cat-new',
			accountId: 'acc-1',
			manualCategory: null,
			manualCategoryKey: null
		}),
		row({
			id: 'tx-3',
			userId: 'user-a',
			categoryId: 'cat-old',
			accountId: 'acc-1',
			manualCategory: null,
			manualCategoryKey: null
		})
	];

	const tables = {
		user: table([row({ id: 'user-a', userId: 'user-a' }), row({ id: 'user-b', userId: 'user-b' })]),
		category: table([
			row({ id: 'cat-old', userId: 'user-a', name: 'Courses', defaultKey: null, nameKey: null }),
			row({
				id: 'cat-new',
				userId: 'user-a',
				name: 'courses',
				defaultKey: 'food',
				nameKey: null,
				createdAt: NEW
			}),
			row({ id: 'cat-other', userId: 'user-b', name: 'Courses', defaultKey: null, nameKey: null })
		]),
		account: table([
			row({
				id: 'acc-1',
				userId: 'user-a',
				name: 'Compte',
				source: 'csv',
				currency: 'EUR',
				netWorthAccountId: null,
				bankConnectionId: null,
				providerAccountId: null,
				providerCashAccountType: null,
				nameKey: null
			})
		]),
		monthlyBudget: table([
			row({
				id: 'bud-old',
				userId: 'user-a',
				categoryName: 'Courses',
				amountCents: 25_000,
				categoryNameKey: null
			}),
			row({
				id: 'bud-new',
				userId: 'user-a',
				categoryName: 'COURSES',
				amountCents: 40_000,
				categoryNameKey: null,
				createdAt: NEW,
				updatedAt: NEW
			})
		]),
		categoryNatureMapping: table([
			row({
				id: 'nat-1',
				userId: 'user-a',
				categoryName: 'Courses',
				nature: 'spending',
				categoryNameKey: null
			})
		]),
		netWorthAccount: table([
			row({ id: 'nwa-1', userId: 'user-a', name: 'Livret A', deletedAt: null, nameKey: null }),
			row({ id: 'nwa-2', userId: 'user-a', name: 'livret a', deletedAt: null, nameKey: null })
		]),
		transaction: table(transactionRows),
		// cat-old is the SURVIVOR of the cat-old/cat-new fold (it is the older row), so split-1
		// carries the loser and split-2 already carries the survivor. `Category` does not cascade
		// into `TransactionSplit`, so without the repoint the category deleteMany would fail on the
		// foreign key in production. The two parts landing in ONE category afterwards is legal —
		// same category twice on a transaction is allowed — and needs no reconciliation.
		transactionSplit: table(
			[
				row({ id: 'split-1', userId: 'user-a', transactionId: 'tx-1', categoryId: 'cat-new' }),
				row({ id: 'split-2', userId: 'user-a', transactionId: 'tx-1', categoryId: 'cat-old' })
			],
			(field, splitRow) =>
				field === 'transaction'
					? (transactionRows.find((tx) => tx.id === splitRow.transactionId) ?? null)
					: null
		)
	};

	const prisma = {
		...tables,
		$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tables))
	};

	return { tables, prisma: prisma as unknown as PrismaClient };
}

describe('runNameKeyBackfill', () => {
	let db: ReturnType<typeof buildDb>;

	beforeEach(() => {
		db = buildDb();
	});

	it('merges categories that fold together and repoints their transactions', async () => {
		expect.assertions(2);

		await runNameKeyBackfill({ prisma: db.prisma });

		expect(db.tables.category.rows.map((row) => row.id)).toEqual(['cat-old', 'cat-other']);
		// tx-1 and tx-2 pointed at the losing row and now point at the survivor.
		//
		// A third assertion used to check that the survivor inherited the loser's `defaultKey`.
		// Since #162 the merge writes no key at all: the column is a tombstone nothing reads, so
		// the survivor simply keeps its own name and there is nothing to inherit.
		expect(db.tables.transaction.rows.every((row) => row.categoryId === 'cat-old')).toBe(true);
	});

	it('repoints the parts of a merged category before the loser row is deleted', async () => {
		expect.assertions(2);

		await runNameKeyBackfill({ prisma: db.prisma });

		// Not "the parts survived" — that would also be true if nothing had been deleted. The claim
		// is that no part is left pointing at a category row that no longer exists, which on a real
		// engine is the difference between a completed merge and a foreign-key error.
		expect(db.tables.transactionSplit.rows.map((r) => r.categoryId)).toEqual([
			'cat-old',
			'cat-old'
		]);
		const survivingCategoryIds = new Set(db.tables.category.rows.map((r) => r.id));
		expect(
			db.tables.transactionSplit.rows.every((r) => survivingCategoryIds.has(r.categoryId as string))
		).toBe(true);
	});

	it('leaves another user rows alone', async () => {
		expect.assertions(2);

		await runNameKeyBackfill({ prisma: db.prisma });

		const other = db.tables.category.rows.find((row) => row.userId === 'user-b');
		expect(other?.name).toBe('Courses');
		expect(other?.nameKey).toBe(computeNameKey('Courses'));
	});

	it('keeps the most recently edited budget amount on the surviving row', async () => {
		expect.assertions(2);

		await runNameKeyBackfill({ prisma: db.prisma });

		expect(db.tables.monthlyBudget.rows).toHaveLength(1);
		expect(db.tables.monthlyBudget.rows[0]).toMatchObject({ id: 'bud-old', amountCents: 40_000 });
	});

	it('fills every key column, including on rows it did not merge', async () => {
		expect.assertions(4);

		await runNameKeyBackfill({ prisma: db.prisma });

		expect(db.tables.account.rows[0].nameKey).toBe(computeNameKey('Compte'));
		expect(db.tables.categoryNatureMapping.rows[0].categoryNameKey).toBe(computeNameKey('Courses'));
		expect(db.tables.netWorthAccount.rows.every((row) => row.nameKey !== null)).toBe(true);
		expect(db.tables.transaction.rows[0].manualCategoryKey).toBe(computeNameKey('Courses'));
	});

	it('reports net worth collisions without touching them', async () => {
		expect.assertions(2);

		const report = await runNameKeyBackfill({ prisma: db.prisma });

		// Merging balances and snapshot histories has no automatic answer, so both rows stay.
		expect(db.tables.netWorthAccount.rows).toHaveLength(2);
		expect(report.users[0].netWorthCollisions[0].names).toEqual(['Livret A', 'livret a']);
	});

	it('leaves a null key on a transaction that has no manual category', async () => {
		expect.assertions(1);

		await runNameKeyBackfill({ prisma: db.prisma });

		const unpinned = db.tables.transaction.rows.find((row) => row.id === 'tx-2');
		expect(unpinned?.manualCategoryKey).toBeNull();
	});

	describe('idempotency', () => {
		it('changes nothing on a second run', async () => {
			expect.assertions(2);

			await runNameKeyBackfill({ prisma: db.prisma });
			const afterFirst = JSON.stringify(db.tables.category.rows);

			const second = await runNameKeyBackfill({ prisma: db.prisma });

			expect(JSON.stringify(db.tables.category.rows)).toBe(afterFirst);
			expect(second.rowsDeleted).toBe(0);
		});

		it('reports nothing left to do once it has run', async () => {
			expect.assertions(2);

			expect(await hasPendingNameKeys(db.prisma)).toBe(true);

			await runNameKeyBackfill({ prisma: db.prisma });

			// This is the gate the boot path uses, so a migrated install skips the scan
			// entirely rather than re-reading every category on every restart.
			expect(await hasPendingNameKeys(db.prisma)).toBe(false);
		});
	});

	describe('dry run', () => {
		it('writes nothing at all', async () => {
			expect.assertions(4);

			await runNameKeyBackfill({ prisma: db.prisma, dryRun: true });

			expect(db.tables.category.rows).toHaveLength(3);
			expect(db.tables.monthlyBudget.rows).toHaveLength(2);
			expect(db.tables.category.rows.every((row) => row.nameKey === null)).toBe(true);
			expect(db.prisma.$transaction).not.toHaveBeenCalled();
		});

		it('produces the same merge decisions the real run would apply', async () => {
			expect.assertions(2);

			const preview = await runNameKeyBackfill({ prisma: db.prisma, dryRun: true });
			const applied = await runNameKeyBackfill({ prisma: buildDb().prisma });

			expect(preview.users[0].categoryMerges).toEqual(applied.users[0].categoryMerges);
			expect(preview.users[0].budgetMerges).toEqual(applied.users[0].budgetMerges);
		});
	});
});
