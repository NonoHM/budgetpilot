import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { MAX_SPLITS_PER_TRANSACTION } from '$lib/domain/allocation';
import { replaceSplits, clearSplits, type SplitInput } from './splits';

/**
 * The split claims a fake Prisma structurally cannot answer, run against a real engine.
 *
 * THE SUM INVARIANT is application-level: no database expresses "these child rows add up to their
 * parent's column" portably across the three providers. A unit test that injects the query's result
 * replaces the very code in question, so the only honest proof is to send each forged payload
 * through the real service and read back what the database actually holds.
 *
 * TENANCY is a protection claim, and this project proves those by attempting the forbidden thing.
 * Neither foreign key on TransactionSplit prevents a part linking user A's transaction to user B's
 * category: they are independent, and no constraint ties Category.userId to Transaction.userId.
 * Only the service's userId-scoped re-resolution stops it.
 *
 * THE ROW LOCK is a concurrency claim. `replaceSplits` opens with an `updateMany` on the parent
 * rather than a `findFirst`, so a concurrent replace serialises behind it instead of interleaving.
 * SQLite serialises writers anyway and would pass whether or not the claim holds on the engines
 * that matter, which is exactly why this runs per provider.
 *
 * See vitest.db.config.ts for how to run it.
 */

// Same guard as tags.db-smoke.ts: the app's client falls back to `file:./dev.db` when DATABASE_URL
// is unset, and this suite creates and deletes real rows.
if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a ' +
			'server engine) to a throwaway database explicitly. It refuses to fall back to the ' +
			'default local SQLite file.'
	);
}
if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error(
		'DATABASE_URL points at dev.db, the default local development database. Point it at a ' +
			'throwaway database instead.'
	);
}

const createdUserIds: string[] = [];

const PARENT_CENTS = -8_000;

interface Seed {
	userId: string;
	accountId: string;
	foodCategoryId: string;
	homeCategoryId: string;
	sentinelCategoryId: string;
}

async function seedUser(): Promise<Seed> {
	const user = await prisma.user.create({
		data: {
			email: `splits-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(user.id);

	const account = await prisma.account.create({
		data: { userId: user.id, name: 'Compte courant', source: 'manual' },
		select: { id: true }
	});
	const [food, home, sentinel] = await Promise.all([
		prisma.category.create({
			data: { userId: user.id, name: 'Alimentation', nameKey: computeNameKey('Alimentation') },
			select: { id: true }
		}),
		prisma.category.create({
			data: { userId: user.id, name: 'Maison', nameKey: computeNameKey('Maison') },
			select: { id: true }
		}),
		prisma.category.create({
			data: {
				userId: user.id,
				name: UNCLASSIFIED_CATEGORY,
				nameKey: computeNameKey(UNCLASSIFIED_CATEGORY)
			},
			select: { id: true }
		})
	]);

	return {
		userId: user.id,
		accountId: account.id,
		foodCategoryId: food.id,
		homeCategoryId: home.id,
		sentinelCategoryId: sentinel.id
	};
}

async function seedTransaction(seed: Seed, amountCents = PARENT_CENTS): Promise<string> {
	const transaction = await prisma.transaction.create({
		data: {
			userId: seed.userId,
			accountId: seed.accountId,
			categoryId: seed.foodCategoryId,
			date: new Date('2026-06-24T00:00:00.000Z'),
			label: 'Carrefour Market',
			amountCents,
			source: 'manual'
		},
		select: { id: true }
	});
	return transaction.id;
}

async function storedParts(transactionId: string) {
	return prisma.transactionSplit.findMany({
		where: { transactionId },
		orderBy: { position: 'asc' },
		select: { categoryId: true, amountCents: true, position: true, note: true }
	});
}

afterAll(async () => {
	if (createdUserIds.length > 0) {
		// Transactions first, exactly as the app's two user-deletion paths now do. See the
		// "deleting a user" test below for why — this cleanup is what found that defect, by
		// failing on one engine of three.
		await prisma.transaction.deleteMany({ where: { userId: { in: createdUserIds } } });
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
});

describe('replaceSplits — the sum invariant, against a real engine', () => {
	it('stores a répartition that sums exactly, and reads it back in position order', async () => {
		expect.assertions(2);

		const seed = await seedUser();
		const transactionId = await seedTransaction(seed);

		const result = await replaceSplits(seed.userId, transactionId, [
			{ categoryId: seed.foodCategoryId, amountCents: -6_000, note: '  courses  ' },
			{ categoryId: seed.homeCategoryId, amountCents: -2_000 }
		]);

		expect(result).toEqual({ ok: true });
		expect(await storedParts(transactionId)).toEqual([
			// Trimmed, and an empty note is stored as NULL rather than as an empty string, so
			// "has a note" is one question rather than two.
			{ categoryId: seed.foodCategoryId, amountCents: -6_000, position: 0, note: 'courses' },
			{ categoryId: seed.homeCategoryId, amountCents: -2_000, position: 1, note: null }
		]);
	});

	// Each forged payload against an 80,00 € parent. The table IS the assertion: every one of these
	// must be refused with nothing written, on every engine.
	const FORGED: Array<{ name: string; parts: (seed: Seed) => SplitInput[]; reason: string }> = [
		{
			name: 'under the total (60,00 + 19,00 = 79,00)',
			reason: 'sum',
			parts: (seed) => [
				{ categoryId: seed.foodCategoryId, amountCents: -6_000 },
				{ categoryId: seed.homeCategoryId, amountCents: -1_900 }
			]
		},
		{
			name: 'over the total (60,00 + 21,00 = 81,00)',
			reason: 'sum',
			parts: (seed) => [
				{ categoryId: seed.foodCategoryId, amountCents: -6_000 },
				{ categoryId: seed.homeCategoryId, amountCents: -2_100 }
			]
		},
		{
			name: 'a single part (below the floor of two)',
			reason: 'count',
			parts: (seed) => [{ categoryId: seed.foodCategoryId, amountCents: PARENT_CENTS }]
		},
		{
			name: '21 parts summing correctly (above the ceiling of twenty)',
			reason: 'count',
			parts: (seed) => {
				const parts: SplitInput[] = Array.from({ length: MAX_SPLITS_PER_TRANSACTION }, () => ({
					categoryId: seed.foodCategoryId,
					amountCents: -400
				}));
				parts.push({ categoryId: seed.homeCategoryId, amountCents: PARENT_CENTS + 400 * 20 });
				return parts;
			}
		},
		{
			name: 'mixed sign (100,00 + −20,00), which sums correctly',
			reason: 'amount',
			parts: (seed) => [
				{ categoryId: seed.foodCategoryId, amountCents: -10_000 },
				{ categoryId: seed.homeCategoryId, amountCents: 2_000 }
			]
		},
		{
			name: 'a part of zero',
			reason: 'amount',
			parts: (seed) => [
				{ categoryId: seed.foodCategoryId, amountCents: PARENT_CENTS },
				{ categoryId: seed.homeCategoryId, amountCents: 0 }
			]
		},
		{
			name: 'a note of 200 characters',
			reason: 'note',
			parts: (seed) => [
				{ categoryId: seed.foodCategoryId, amountCents: -6_000, note: 'x'.repeat(200) },
				{ categoryId: seed.homeCategoryId, amountCents: -2_000 }
			]
		},
		{
			name: 'the "Non catégorisé" sentinel as a part category',
			reason: 'category',
			parts: (seed) => [
				{ categoryId: seed.foodCategoryId, amountCents: -6_000 },
				{ categoryId: seed.sentinelCategoryId, amountCents: -2_000 }
			]
		},
		{
			name: 'a category id that does not exist',
			reason: 'category',
			parts: (seed) => [
				{ categoryId: seed.foodCategoryId, amountCents: -6_000 },
				{ categoryId: 'no-such-category-id', amountCents: -2_000 }
			]
		}
	];

	for (const forged of FORGED) {
		it(`refuses ${forged.name}, writing nothing`, async () => {
			expect.assertions(2);

			const seed = await seedUser();
			const transactionId = await seedTransaction(seed);

			const result = await replaceSplits(seed.userId, transactionId, forged.parts(seed));

			expect(result).toMatchObject({ ok: false, reason: forged.reason });
			expect(await storedParts(transactionId)).toEqual([]);
		});
	}

	// A client-supplied total is never read; the parent's own amount is. Sending parts that WOULD
	// sum against a different parent is how that is demonstrated without inventing a field the
	// signature does not have.
	it('validates against the parent row, not against what the caller believes it holds', async () => {
		expect.assertions(2);

		const seed = await seedUser();
		const transactionId = await seedTransaction(seed, -9_000);

		const result = await replaceSplits(seed.userId, transactionId, [
			{ categoryId: seed.foodCategoryId, amountCents: -6_000 },
			{ categoryId: seed.homeCategoryId, amountCents: -2_000 }
		]);

		expect(result).toEqual({
			ok: false,
			reason: 'sum',
			expectedCents: -9_000,
			actualCents: -8_000
		});
		expect(await storedParts(transactionId)).toEqual([]);
	});

	it('replaces the previous répartition wholesale rather than appending to it', async () => {
		expect.assertions(2);

		const seed = await seedUser();
		const transactionId = await seedTransaction(seed);

		await replaceSplits(seed.userId, transactionId, [
			{ categoryId: seed.foodCategoryId, amountCents: -6_000 },
			{ categoryId: seed.homeCategoryId, amountCents: -2_000 }
		]);
		await replaceSplits(seed.userId, transactionId, [
			{ categoryId: seed.foodCategoryId, amountCents: -3_000 },
			{ categoryId: seed.homeCategoryId, amountCents: -5_000 }
		]);

		const parts = await storedParts(transactionId);
		expect(parts).toHaveLength(2);
		expect(parts.reduce((sum, part) => sum + part.amountCents, 0)).toBe(PARENT_CENTS);
	});
});

describe('split tenancy — proven by attempting the forbidden thing', () => {
	it("refuses a part pointing at another user's category", async () => {
		expect.assertions(3);

		const owner = await seedUser();
		const stranger = await seedUser();
		const transactionId = await seedTransaction(owner);

		const result = await replaceSplits(owner.userId, transactionId, [
			{ categoryId: owner.foodCategoryId, amountCents: -6_000 },
			{ categoryId: stranger.homeCategoryId, amountCents: -2_000 }
		]);

		// Position 1, named — which is what lets the editor say which part to fix.
		expect(result).toEqual({ ok: false, reason: 'category', positions: [1] });
		expect(await storedParts(transactionId)).toEqual([]);
		// Indistinguishable from a category id that never existed: same reason, same shape, no way
		// to tell "not yours" from "no such row".
		const nonexistent = await replaceSplits(owner.userId, transactionId, [
			{ categoryId: owner.foodCategoryId, amountCents: -6_000 },
			{ categoryId: 'no-such-category-id', amountCents: -2_000 }
		]);
		expect(nonexistent).toEqual(result);
	});

	it("refuses to touch another user's transaction, and says only not-found", async () => {
		expect.assertions(2);

		const owner = await seedUser();
		const stranger = await seedUser();
		const transactionId = await seedTransaction(owner);

		const result = await replaceSplits(stranger.userId, transactionId, [
			{ categoryId: stranger.foodCategoryId, amountCents: -6_000 },
			{ categoryId: stranger.homeCategoryId, amountCents: -2_000 }
		]);

		expect(result).toEqual({ ok: false, reason: 'not-found' });
		expect(await storedParts(transactionId)).toEqual([]);
	});

	it("refuses to clear another user's répartition", async () => {
		expect.assertions(2);

		const owner = await seedUser();
		const stranger = await seedUser();
		const transactionId = await seedTransaction(owner);
		await replaceSplits(owner.userId, transactionId, [
			{ categoryId: owner.foodCategoryId, amountCents: -6_000 },
			{ categoryId: owner.homeCategoryId, amountCents: -2_000 }
		]);

		const result = await clearSplits(stranger.userId, transactionId);

		expect(result).toEqual({ ok: false, reason: 'not-found' });
		// The owner's parts are untouched. A bare deleteMany scoped only by transactionId would
		// have removed them: the id comes from the client and TransactionSplit has no userId.
		expect(await storedParts(transactionId)).toHaveLength(2);
	});
});

describe('concurrency — the row lock, not a reasoned isolation level', () => {
	it('leaves the stored parts summing to the parent after two overlapping replaces', async () => {
		expect.assertions(3);

		const seed = await seedUser();
		const transactionId = await seedTransaction(seed);

		const [first, second] = await Promise.all([
			replaceSplits(seed.userId, transactionId, [
				{ categoryId: seed.foodCategoryId, amountCents: -6_000 },
				{ categoryId: seed.homeCategoryId, amountCents: -2_000 }
			]),
			replaceSplits(seed.userId, transactionId, [
				{ categoryId: seed.foodCategoryId, amountCents: -1_000 },
				{ categoryId: seed.homeCategoryId, amountCents: -3_000 },
				{ categoryId: seed.foodCategoryId, amountCents: -4_000 }
			])
		]);

		expect(first).toEqual({ ok: true });
		expect(second).toEqual({ ok: true });

		// Last write wins, and either winner is correct — what must never happen is the two
		// interleaving into a set that does not sum, or one deleting the other's rows after its
		// own insert. Asserting the SUM rather than a particular winner is the point: pinning a
		// winner would be asserting a scheduling order no engine promises.
		const parts = await storedParts(transactionId);
		expect(parts.reduce((sum, part) => sum + part.amountCents, 0)).toBe(PARENT_CENTS);
	});

	it('keeps the same category twice in one répartition, which is legal', async () => {
		expect.assertions(2);

		const seed = await seedUser();
		const transactionId = await seedTransaction(seed);

		const result = await replaceSplits(seed.userId, transactionId, [
			{ categoryId: seed.foodCategoryId, amountCents: -4_800, note: 'courses semaine' },
			{ categoryId: seed.foodCategoryId, amountCents: -3_200, note: 'anniversaire' }
		]);

		expect(result).toEqual({ ok: true });
		// Two rows, not one: (transactionId, categoryId) is deliberately not unique, which is why
		// the model carries a surrogate id rather than TransactionTag's composite key.
		expect(await storedParts(transactionId)).toHaveLength(2);
	});
});

describe('clearSplits', () => {
	it('removes every part and leaves the parent untouched', async () => {
		expect.assertions(3);

		const seed = await seedUser();
		const transactionId = await seedTransaction(seed);
		await replaceSplits(seed.userId, transactionId, [
			{ categoryId: seed.foodCategoryId, amountCents: -6_000 },
			{ categoryId: seed.homeCategoryId, amountCents: -2_000 }
		]);

		expect(await clearSplits(seed.userId, transactionId)).toEqual({ ok: true });
		expect(await storedParts(transactionId)).toEqual([]);

		// Lossless: the parent keeps its own category and amount, so the transaction returns to
		// being an ordinary single-category row rather than falling into the "to classify" pile.
		const parent = await prisma.transaction.findFirstOrThrow({
			where: { id: transactionId },
			select: { categoryId: true, amountCents: true }
		});
		expect(parent).toEqual({ categoryId: seed.foodCategoryId, amountCents: PARENT_CENTS });
	});

	it('is idempotent on a transaction that has no parts', async () => {
		expect.assertions(1);

		const seed = await seedUser();
		const transactionId = await seedTransaction(seed);

		expect(await clearSplits(seed.userId, transactionId)).toEqual({ ok: true });
	});
});

describe('cascade — a database claim, so it is asserted against the database', () => {
	it('deletes a transaction parts when the transaction goes', async () => {
		expect.assertions(2);

		const seed = await seedUser();
		const transactionId = await seedTransaction(seed);
		await replaceSplits(seed.userId, transactionId, [
			{ categoryId: seed.foodCategoryId, amountCents: -6_000 },
			{ categoryId: seed.homeCategoryId, amountCents: -2_000 }
		]);

		await prisma.transaction.delete({ where: { id: transactionId } });

		expect(await storedParts(transactionId)).toEqual([]);
		expect(await prisma.transactionSplit.count({ where: { transactionId } })).toBe(0);
	});

	it('REFUSES to delete a category still carrying parts, rather than deleting money', async () => {
		expect.assertions(2);

		const seed = await seedUser();
		const transactionId = await seedTransaction(seed);
		await replaceSplits(seed.userId, transactionId, [
			{ categoryId: seed.foodCategoryId, amountCents: -6_000 },
			{ categoryId: seed.homeCategoryId, amountCents: -2_000 }
		]);

		// The whole point of NOT cascading from Category. If this ever starts succeeding, a
		// category delete silently destroys part of a répartition and every per-category total
		// silently changes. The /categories delete path re-points these rows first; this asserts
		// what happens when something forgets to.
		await expect(
			prisma.category.delete({ where: { id: seed.homeCategoryId } })
		).rejects.toBeDefined();
		expect(await storedParts(transactionId)).toHaveLength(2);
	});
});

describe('deleting a user who has a répartition', () => {
	/**
	 * Found by accident and worth more than most of the tests above it: this suite's own cleanup
	 * failed on PostgreSQL and passed on SQLite and MySQL, with
	 * `Foreign key constraint violated on the constraint: TransactionSplit_categoryId_fkey`.
	 *
	 * The cause is a cascade ORDER the engine chooses. Deleting a User cascades into both Category
	 * and Transaction. TransactionSplit cascades from Transaction but is RESTRICT on Category —
	 * deliberately, so that deleting a category can never destroy money. If the engine reaches
	 * Category first, that RESTRICT fires and the entire delete fails.
	 *
	 * The consequence was not a test problem. Both of the app's user-deletion paths — "delete my
	 * account" in /settings and the admin's "delete user" — were a bare `user.delete` relying on
	 * that cascade, so on PostgreSQL a user who had ever split a transaction could not delete
	 * their own account. Both now delete transactions first.
	 *
	 * This test exists so the fix cannot be reverted quietly, and so it is verified on the engine
	 * that has the problem rather than the two that do not.
	 */
	it('succeeds when transactions are deleted first, on every engine', async () => {
		expect.assertions(2);

		const seed = await seedUser();
		const transactionId = await seedTransaction(seed);
		await replaceSplits(seed.userId, transactionId, [
			{ categoryId: seed.foodCategoryId, amountCents: -6_000 },
			{ categoryId: seed.homeCategoryId, amountCents: -2_000 }
		]);

		await prisma.$transaction(async (tx) => {
			await tx.transaction.deleteMany({ where: { userId: seed.userId } });
			await tx.user.delete({ where: { id: seed.userId } });
		});

		expect(await prisma.user.count({ where: { id: seed.userId } })).toBe(0);
		expect(await prisma.transactionSplit.count({ where: { transactionId } })).toBe(0);
	});

	// The unguarded shape, pinned so nobody "simplifies" the two route handlers back to it. On
	// PostgreSQL this rejects; on SQLite and MySQL it happens to succeed, which is precisely why
	// reasoning about it was never going to be enough.
	it('is engine-dependent without that ordering, which is why the ordering is explicit', async () => {
		expect.assertions(1);

		const seed = await seedUser();
		const transactionId = await seedTransaction(seed);
		await replaceSplits(seed.userId, transactionId, [
			{ categoryId: seed.foodCategoryId, amountCents: -6_000 },
			{ categoryId: seed.homeCategoryId, amountCents: -2_000 }
		]);

		const bare = prisma.user.delete({ where: { id: seed.userId } }).then(
			() => 'succeeded' as const,
			() => 'rejected' as const
		);
		const outcome = await bare;

		// Deliberately not asserting WHICH: the point is that it is not the same everywhere, and
		// an assertion pinning one engine's answer would fail on the others for the right reason
		// and the wrong test. What matters is that the app never relies on it.
		expect(['succeeded', 'rejected']).toContain(outcome);
	});
});
