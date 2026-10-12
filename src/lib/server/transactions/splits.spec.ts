import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SplitInput } from './splits';

/**
 * Fake Prisma for `replaceSplits` / `clearSplits`.
 *
 * WHAT THIS FILE CAN PROVE, and what it structurally cannot. This fake records the SHAPE of every
 * query the validator issues and lets each test script exactly what a query returns — that is
 * enough to pin every branch of `ReplaceSplitsResult` precisely and fast, on every push. It is NOT
 * enough to prove the sum invariant holds against a real database, that tenancy scoping actually
 * excludes another user's rows at the SQL level, or that the parent row lock serialises concurrent
 * writers — a unit test that injects the query's result replaces the very code that would have to
 * get those things right. Those three claims are proven against real sqlite/postgresql/mysql
 * engines in `splits.db-smoke.ts`; nothing here should be read as evidence for them.
 */
const db = vi.hoisted(() => {
	const tx = {
		transaction: {
			updateMany: vi.fn(),
			findFirstOrThrow: vi.fn()
		},
		category: {
			findMany: vi.fn()
		},
		transactionSplit: {
			deleteMany: vi.fn(),
			createMany: vi.fn()
		}
	};
	const prisma = {
		$transaction: vi.fn((callback: (t: typeof tx) => Promise<unknown>) => callback(tx))
	};
	return { prisma, tx };
});

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { replaceSplits, clearSplits } = await import('./splits');
const { computeNameKey } = await import('$lib/server/naming/nameKey');
const { UNCLASSIFIED_CATEGORY } = await import('$lib/domain/categories');
const { MAX_SPLITS_PER_TRANSACTION, MIN_SPLITS_PER_TRANSACTION } =
	await import('$lib/domain/allocation');

const USER_ID = 'user-a';
const TRANSACTION_ID = 'tx-1';
const PARENT_CENTS = -8_000;

const FOOD_CATEGORY_ID = 'cat-food';
const HOME_CATEGORY_ID = 'cat-home';
const SENTINEL_CATEGORY_ID = 'cat-sentinel';

/**
 * Categories the fake resolve query knows about. `category.findMany` below only ever returns rows
 * from this table, filtered to the ids actually requested — exactly what the real query does,
 * scoped by `userId` — so a foreign or nonexistent id resolves to nothing, same as against a real
 * database.
 */
const KNOWN_CATEGORIES = [
	{ id: FOOD_CATEGORY_ID, nameKey: computeNameKey('Alimentation') },
	{ id: HOME_CATEGORY_ID, nameKey: computeNameKey('Maison') },
	{ id: SENTINEL_CATEGORY_ID, nameKey: computeNameKey(UNCLASSIFIED_CATEGORY) }
];

beforeEach(() => {
	vi.clearAllMocks();
	db.tx.transaction.updateMany.mockResolvedValue({ count: 1 });
	db.tx.transaction.findFirstOrThrow.mockResolvedValue({ amountCents: PARENT_CENTS });
	db.tx.category.findMany.mockImplementation(
		async ({ where }: { where: { id: { in: string[] } } }) =>
			KNOWN_CATEGORIES.filter((category) => where.id.in.includes(category.id))
	);
	db.tx.transactionSplit.deleteMany.mockResolvedValue({ count: 0 });
	db.tx.transactionSplit.createMany.mockResolvedValue({ count: 0 });
});

describe('replaceSplits — success', () => {
	it('returns ok:true and writes parts with sequential positions, trimmed notes, and null for an empty note', async () => {
		expect.assertions(2);

		const parts: SplitInput[] = [
			{ categoryId: FOOD_CATEGORY_ID, amountCents: -3_000, note: '  groceries  ' },
			{ categoryId: HOME_CATEGORY_ID, amountCents: -3_000, note: '   ' },
			{ categoryId: FOOD_CATEGORY_ID, amountCents: -2_000 }
		];

		const result = await replaceSplits(USER_ID, TRANSACTION_ID, parts);

		expect(result).toEqual({ ok: true });
		expect(db.tx.transactionSplit.createMany.mock.calls[0][0].data).toEqual([
			{
				transactionId: TRANSACTION_ID,
				categoryId: FOOD_CATEGORY_ID,
				amountCents: -3_000,
				position: 0,
				note: 'groceries'
			},
			{
				transactionId: TRANSACTION_ID,
				categoryId: HOME_CATEGORY_ID,
				amountCents: -3_000,
				position: 1,
				note: null
			},
			{
				transactionId: TRANSACTION_ID,
				categoryId: FOOD_CATEGORY_ID,
				amountCents: -2_000,
				position: 2,
				note: null
			}
		]);
	});

	// Ordering is load-bearing, not incidental (see splits.ts's own docstring): the updateMany is the
	// ownership proof AND the row lock, so anything that ran before it would be acting on an unproven,
	// unlocked row. deleteMany must then precede createMany so a partial répartition is never
	// observable. `invocationCallOrder` pins that sequence directly rather than trusting the source
	// read.
	it('locks and proves ownership (updateMany) before deleting, and deletes before inserting', async () => {
		expect.assertions(2);

		await replaceSplits(USER_ID, TRANSACTION_ID, [
			{ categoryId: FOOD_CATEGORY_ID, amountCents: -6_000 },
			{ categoryId: HOME_CATEGORY_ID, amountCents: -2_000 }
		]);

		const updateOrder = db.tx.transaction.updateMany.mock.invocationCallOrder[0];
		const deleteOrder = db.tx.transactionSplit.deleteMany.mock.invocationCallOrder[0];
		const createOrder = db.tx.transactionSplit.createMany.mock.invocationCallOrder[0];
		expect(updateOrder).toBeLessThan(deleteOrder);
		expect(deleteOrder).toBeLessThan(createOrder);
	});
});

describe('replaceSplits — count refusal, checked before opening a transaction', () => {
	it('refuses a single part, below the floor of two', async () => {
		expect.assertions(2);

		const parts: SplitInput[] = [{ categoryId: FOOD_CATEGORY_ID, amountCents: PARENT_CENTS }];
		expect(parts).toHaveLength(MIN_SPLITS_PER_TRANSACTION - 1);

		const result = await replaceSplits(USER_ID, TRANSACTION_ID, parts);

		expect(result).toEqual({ ok: false, reason: 'count', count: 1 });
	});

	it('refuses 21 parts, above the ceiling of twenty, opening no Prisma transaction at all', async () => {
		expect.assertions(4);

		const parts: SplitInput[] = Array.from(
			{ length: MAX_SPLITS_PER_TRANSACTION + 1 },
			(_, index) => ({ categoryId: FOOD_CATEGORY_ID, amountCents: index === 0 ? -1 : 0 })
		);
		expect(parts).toHaveLength(21);

		const result = await replaceSplits(USER_ID, TRANSACTION_ID, parts);

		expect(result).toEqual({ ok: false, reason: 'count', count: 21 });
		// The count is checked BEFORE `prisma.$transaction` is even called, so a forged request with
		// 10 000 parts never holds a pooled connection while being refused. Asserting `$transaction`
		// itself was never invoked is what pins that, rather than merely checking the two mutating
		// calls a passing check would also have skipped.
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
		expect(db.tx.transactionSplit.createMany).not.toHaveBeenCalled();
	});
});

describe('replaceSplits — not-found', () => {
	it('returns not-found when updateMany proves no ownership, and writes nothing', async () => {
		expect.assertions(3);

		db.tx.transaction.updateMany.mockResolvedValue({ count: 0 });

		const result = await replaceSplits(USER_ID, TRANSACTION_ID, [
			{ categoryId: FOOD_CATEGORY_ID, amountCents: -6_000 },
			{ categoryId: HOME_CATEGORY_ID, amountCents: -2_000 }
		]);

		expect(result).toEqual({ ok: false, reason: 'not-found' });
		expect(db.tx.transactionSplit.deleteMany).not.toHaveBeenCalled();
		expect(db.tx.transactionSplit.createMany).not.toHaveBeenCalled();
	});
});

describe('replaceSplits — sum refusal', () => {
	it('reports the exact figures when the parts sum UNDER the parent total', async () => {
		expect.assertions(3);

		const result = await replaceSplits(USER_ID, TRANSACTION_ID, [
			{ categoryId: FOOD_CATEGORY_ID, amountCents: -6_000 },
			{ categoryId: HOME_CATEGORY_ID, amountCents: -1_900 }
		]);

		expect(result).toEqual({
			ok: false,
			reason: 'sum',
			expectedCents: PARENT_CENTS,
			actualCents: -7_900
		});
		expect(db.tx.transactionSplit.deleteMany).not.toHaveBeenCalled();
		expect(db.tx.transactionSplit.createMany).not.toHaveBeenCalled();
	});

	it('reports the exact figures when the parts sum OVER the parent total', async () => {
		expect.assertions(3);

		const result = await replaceSplits(USER_ID, TRANSACTION_ID, [
			{ categoryId: FOOD_CATEGORY_ID, amountCents: -6_000 },
			{ categoryId: HOME_CATEGORY_ID, amountCents: -2_100 }
		]);

		expect(result).toEqual({
			ok: false,
			reason: 'sum',
			expectedCents: PARENT_CENTS,
			actualCents: -8_100
		});
		expect(db.tx.transactionSplit.deleteMany).not.toHaveBeenCalled();
		expect(db.tx.transactionSplit.createMany).not.toHaveBeenCalled();
	});
});

describe('replaceSplits — amount refusal', () => {
	it('flags a zero-valued part', async () => {
		expect.assertions(3);

		const result = await replaceSplits(USER_ID, TRANSACTION_ID, [
			{ categoryId: FOOD_CATEGORY_ID, amountCents: PARENT_CENTS },
			{ categoryId: HOME_CATEGORY_ID, amountCents: 0 }
		]);

		expect(result).toEqual({ ok: false, reason: 'amount', positions: [1] });
		expect(db.tx.transactionSplit.deleteMany).not.toHaveBeenCalled();
		expect(db.tx.transactionSplit.createMany).not.toHaveBeenCalled();
	});

	it("flags a part whose sign is opposite the parent's, even though the total still sums correctly", async () => {
		expect.assertions(3);

		const result = await replaceSplits(USER_ID, TRANSACTION_ID, [
			{ categoryId: FOOD_CATEGORY_ID, amountCents: -10_000 },
			{ categoryId: HOME_CATEGORY_ID, amountCents: 2_000 }
		]);

		expect(result).toEqual({ ok: false, reason: 'amount', positions: [1] });
		expect(db.tx.transactionSplit.deleteMany).not.toHaveBeenCalled();
		expect(db.tx.transactionSplit.createMany).not.toHaveBeenCalled();
	});

	it('flags a non-safe-integer amount', async () => {
		expect.assertions(3);

		const result = await replaceSplits(USER_ID, TRANSACTION_ID, [
			{ categoryId: FOOD_CATEGORY_ID, amountCents: -6_000 },
			{ categoryId: HOME_CATEGORY_ID, amountCents: -2_000.5 }
		]);

		expect(result).toEqual({ ok: false, reason: 'amount', positions: [1] });
		expect(db.tx.transactionSplit.deleteMany).not.toHaveBeenCalled();
		expect(db.tx.transactionSplit.createMany).not.toHaveBeenCalled();
	});

	// THE OTHER SIGN. Every fixture above is an expense, which is most of this app's transactions
	// and therefore the sign a suite reaches for without deciding to. The rule under test compares
	// a part's sign against its PARENT's, so an expense-only suite would pass unchanged if the
	// comparison were replaced by "the part must be negative" — and every income répartition would
	// be refused in production with nothing red.
	it('accepts an all-positive répartition of an income, and refuses a negative part in it', async () => {
		expect.assertions(3);

		db.tx.transaction.findFirstOrThrow.mockResolvedValue({ amountCents: 8_000 });

		const accepted = await replaceSplits(USER_ID, TRANSACTION_ID, [
			{ categoryId: FOOD_CATEGORY_ID, amountCents: 6_000 },
			{ categoryId: HOME_CATEGORY_ID, amountCents: 2_000 }
		]);
		expect(accepted).toEqual({ ok: true });
		expect(db.tx.transactionSplit.createMany).toHaveBeenCalledTimes(1);

		const refused = await replaceSplits(USER_ID, TRANSACTION_ID, [
			{ categoryId: FOOD_CATEGORY_ID, amountCents: 13_000 },
			{ categoryId: HOME_CATEGORY_ID, amountCents: -5_000 }
		]);
		expect(refused).toEqual({ ok: false, reason: 'amount', positions: [1] });
	});

	it('names BOTH bad positions when two parts are invalid at once', async () => {
		expect.assertions(3);

		const result = await replaceSplits(USER_ID, TRANSACTION_ID, [
			{ categoryId: FOOD_CATEGORY_ID, amountCents: 0 },
			{ categoryId: HOME_CATEGORY_ID, amountCents: -6_000 },
			{ categoryId: FOOD_CATEGORY_ID, amountCents: 2_000 }
		]);

		expect(result).toEqual({ ok: false, reason: 'amount', positions: [0, 2] });
		expect(db.tx.transactionSplit.deleteMany).not.toHaveBeenCalled();
		expect(db.tx.transactionSplit.createMany).not.toHaveBeenCalled();
	});
});

describe('replaceSplits — note refusal', () => {
	it('flags a note over MAX_SPLIT_NOTE_LENGTH characters', async () => {
		expect.assertions(3);

		const result = await replaceSplits(USER_ID, TRANSACTION_ID, [
			{ categoryId: FOOD_CATEGORY_ID, amountCents: -6_000, note: 'x'.repeat(81) },
			{ categoryId: HOME_CATEGORY_ID, amountCents: -2_000 }
		]);

		expect(result).toEqual({ ok: false, reason: 'note', positions: [0] });
		expect(db.tx.transactionSplit.deleteMany).not.toHaveBeenCalled();
		expect(db.tx.transactionSplit.createMany).not.toHaveBeenCalled();
	});
});

describe('replaceSplits — category refusal', () => {
	it('flags a category id the resolve query does not return', async () => {
		expect.assertions(3);

		const result = await replaceSplits(USER_ID, TRANSACTION_ID, [
			{ categoryId: FOOD_CATEGORY_ID, amountCents: -6_000 },
			{ categoryId: 'no-such-category-id', amountCents: -2_000 }
		]);

		expect(result).toEqual({ ok: false, reason: 'category', positions: [1] });
		expect(db.tx.transactionSplit.deleteMany).not.toHaveBeenCalled();
		expect(db.tx.transactionSplit.createMany).not.toHaveBeenCalled();
	});

	it('flags the "Non catégorisé" sentinel category, computed from the real modules rather than a hardcoded string', async () => {
		expect.assertions(3);

		// Sanity on the fixture itself: the sentinel row really does carry the sentinel key, so the
		// refusal below is exercising the nameKey check and not merely an unresolved id.
		const sentinel = KNOWN_CATEGORIES.find((category) => category.id === SENTINEL_CATEGORY_ID);
		expect(sentinel?.nameKey).toBe(computeNameKey(UNCLASSIFIED_CATEGORY));

		const result = await replaceSplits(USER_ID, TRANSACTION_ID, [
			{ categoryId: FOOD_CATEGORY_ID, amountCents: -6_000 },
			{ categoryId: SENTINEL_CATEGORY_ID, amountCents: -2_000 }
		]);

		expect(result).toEqual({ ok: false, reason: 'category', positions: [1] });
		expect(db.tx.transactionSplit.createMany).not.toHaveBeenCalled();
	});
});

describe('clearSplits', () => {
	it('deletes by transactionId and returns ok:true', async () => {
		expect.assertions(2);

		const result = await clearSplits(USER_ID, TRANSACTION_ID);

		expect(result).toEqual({ ok: true });
		expect(db.tx.transactionSplit.deleteMany.mock.calls[0][0]).toEqual({
			where: { transactionId: TRANSACTION_ID }
		});
	});

	it('returns not-found when updateMany proves no ownership, and deletes nothing', async () => {
		expect.assertions(2);

		db.tx.transaction.updateMany.mockResolvedValue({ count: 0 });

		const result = await clearSplits(USER_ID, TRANSACTION_ID);

		expect(result).toEqual({ ok: false, reason: 'not-found' });
		expect(db.tx.transactionSplit.deleteMany).not.toHaveBeenCalled();
	});
});
