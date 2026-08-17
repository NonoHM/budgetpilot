import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { pickTagColorToken } from '$lib/domain/tags';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { deleteImportBatch } from './deleteBatch';

/**
 * What the shared delete actually destroys, asked of a real engine.
 *
 * The unit spec can only say which Prisma calls were made. Three of the claims here are the
 * database's to answer and no mock can stand in for them:
 *
 * - **The cascade.** `TransactionSplit` and `TransactionTag` are declared `onDelete: Cascade` from
 *   `Transaction`, and whether that removes a user's own splits and tags is the engine executing
 *   the constraint rather than Prisma. It is also the sentence the correction's control promises,
 *   so it is worth proving rather than reading off the schema.
 * - **Tenancy.** `deleteImportBatch` refusing another user's batch is a `findFirst` clause, and a
 *   clause is only a protection if the engine applies it. The attempt is made rather than asserted
 *   about, in the shape `e2e/idor-two-account.spec.ts` uses.
 * - **The blast radius.** A correction writes a second batch and then deletes the first. If the
 *   delete reached beyond its own batch the corrected import would be destroyed by the repair, and
 *   `deleteMany` semantics under a scoped filter is exactly the sort of thing that differs.
 *
 * See vitest.db.config.ts for how to run it.
 */

// Same guard as the sibling smoke suites: the app's client falls back to `file:./dev.db` when
// DATABASE_URL is unset, and this suite creates and deletes real rows.
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

interface Seed {
	userId: string;
	accountId: string;
	categoryId: string;
	tagId: string;
}

async function seedUser(): Promise<Seed> {
	const user = await prisma.user.create({
		data: {
			email: `delete-batch-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(user.id);

	const account = await prisma.account.create({
		data: { userId: user.id, name: 'Compte courant', source: 'manual' },
		select: { id: true }
	});
	const category = await prisma.category.create({
		data: { userId: user.id, name: 'Courses' },
		select: { id: true }
	});
	const tag = await prisma.tag.create({
		// `computeNameKey` rather than a hand-lowered string: it is the only folding in this repo,
		// and `@@unique([userId, nameKey])` is what would notice a second one.
		data: {
			userId: user.id,
			name: 'Vacances',
			nameKey: computeNameKey('Vacances'),
			colorToken: pickTagColorToken(computeNameKey('Vacances'))
		},
		select: { id: true }
	});
	return { userId: user.id, accountId: account.id, categoryId: category.id, tagId: tag.id };
}

/** A batch of two rows, the first of which carries a split and a tag. */
async function seedBatch(seed: Seed, fileName: string): Promise<string> {
	const batch = await prisma.importBatch.create({
		data: { userId: seed.userId, source: 'csv', fileName, profile: 'generic', rowCount: 2 },
		select: { id: true }
	});

	const first = await prisma.transaction.create({
		data: {
			userId: seed.userId,
			accountId: seed.accountId,
			categoryId: seed.categoryId,
			importBatchId: batch.id,
			date: new Date('2026-06-01T00:00:00.000Z'),
			label: `${fileName} loyer`,
			amountCents: -78_000,
			source: 'csv'
		},
		select: { id: true }
	});
	await prisma.transaction.create({
		data: {
			userId: seed.userId,
			accountId: seed.accountId,
			categoryId: seed.categoryId,
			importBatchId: batch.id,
			date: new Date('2026-06-06T00:00:00.000Z'),
			label: `${fileName} salaire`,
			amountCents: 214_000,
			source: 'csv'
		}
	});

	// Written through Prisma rather than through the split and tag services, because the claim
	// under test is the CASCADE from Transaction, which is the schema's and the engine's. Going
	// through the services would test them instead, and they have their own smoke suites.
	await prisma.transactionSplit.create({
		data: {
			transactionId: first.id,
			categoryId: seed.categoryId,
			amountCents: -78_000,
			position: 0
		}
	});
	await prisma.transactionTag.create({ data: { transactionId: first.id, tagId: seed.tagId } });

	return batch.id;
}

afterAll(async () => {
	if (createdUserIds.length === 0) return;
	// The transactions FIRST, and this is not tidiness. Deleting the user cascades to its
	// categories, and `TransactionSplit.categoryId` deliberately does NOT cascade, because deleting
	// a category must never delete money. A user still holding a split therefore cannot be removed
	// in one statement, and the engines disagree about it: SQLite accepted this teardown and
	// PostgreSQL refused it with `TransactionSplit_categoryId_fkey`. Removing the transactions
	// first cascades the splits away and leaves the categories free.
	await prisma.transaction.deleteMany({ where: { userId: { in: createdUserIds } } });
	await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

describe('deleteImportBatch against a real engine', () => {
	it('takes the batch, its transactions, and the splits and tags that cascade from them', async () => {
		expect.assertions(5);

		const seed = await seedUser();
		const batchId = await seedBatch(seed, 'releve-juin.csv');

		// Non-zero before, so the emptiness assertions below have an absolute figure beside them and
		// a seed that silently wrote nothing cannot pass as a successful delete.
		expect(await prisma.transaction.count({ where: { importBatchId: batchId } })).toBe(2);

		expect(await deleteImportBatch(seed.userId, batchId)).toBe(true);

		expect(await prisma.importBatch.count({ where: { id: batchId } })).toBe(0);
		expect(await prisma.transaction.count({ where: { importBatchId: batchId } })).toBe(0);
		// The cascade, which is the sentence the correction's control promises the user.
		expect(
			(await prisma.transactionSplit.count({ where: { categoryId: seed.categoryId } })) +
				(await prisma.transactionTag.count({ where: { tagId: seed.tagId } }))
		).toBe(0);
	});

	it("refuses another user's batch and destroys nothing of theirs", async () => {
		expect.assertions(3);

		const owner = await seedUser();
		const attacker = await seedUser();
		const batchId = await seedBatch(owner, 'releve-juillet.csv');

		// The attempt is made rather than reasoned about. The id is real and correct; only the
		// session is wrong, which is the shape of every IDOR this project tests for.
		expect(await deleteImportBatch(attacker.userId, batchId)).toBe(false);

		expect(await prisma.importBatch.count({ where: { id: batchId } })).toBe(1);
		expect(await prisma.transaction.count({ where: { importBatchId: batchId } })).toBe(2);
	});

	it('leaves the corrected batch alone when the batch it replaces is deleted', async () => {
		expect.assertions(4);

		const seed = await seedUser();
		const wrong = await seedBatch(seed, 'releve-mauvaises-colonnes.csv');
		// Write, THEN delete. The order is the control and the reason is in deleteBatch.ts; this
		// asserts the half of it that a unit test cannot see, that the delete stays inside its own
		// batch when a second one of the same user exists.
		const corrected = await seedBatch(seed, 'releve-corrige.csv');

		expect(await deleteImportBatch(seed.userId, wrong)).toBe(true);

		expect(await prisma.transaction.count({ where: { importBatchId: wrong } })).toBe(0);
		expect(await prisma.importBatch.count({ where: { id: corrected } })).toBe(1);
		expect(await prisma.transaction.count({ where: { importBatchId: corrected } })).toBe(2);
	});
});
