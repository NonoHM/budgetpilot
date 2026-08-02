import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { setTransactionTags, pruneOrphanTags, resolveTagByName } from './service';
import { applyTagToFilteredSet, undoBulkTag } from './bulk';

/**
 * The two tag claims a fake Prisma structurally cannot answer.
 *
 * TENANCY is a protection claim, and this project proves those by attempting the forbidden thing.
 * Neither foreign key on TransactionTag prevents a row linking user A's transaction to user B's
 * tag: they are independent, and no constraint ties Tag.userId to Transaction.userId. Only the
 * service's userId-scoped resolve stops it, so the attempt has to be made against a real engine
 * where those constraints actually exist.
 *
 * THE PRUNE RACE is a concurrency claim. `pruneOrphanTags` puts the emptiness condition inside the
 * DELETE rather than in a preceding read, so a request tagging the same tag at that moment should
 * lose the delete rather than orphan a link. That argument is sound in principle and is exactly the
 * kind this project has learned to run rather than reason about. SQLite serializes writers, so it
 * would pass locally whether or not the claim holds on the engines that matter.
 *
 * Whether pruneOrphanTags also needs withConcurrentWriteRetry is answered BY this file, not
 * assumed in advance.
 *
 * See vitest.db.config.ts for how to run it.
 */

// Same guard as crossProvider.db-smoke.ts: the app's client falls back to `file:./dev.db` when
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

async function seedUser(): Promise<{ userId: string; accountId: string; categoryId: string }> {
	const user = await prisma.user.create({
		data: {
			email: `tags-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
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
	return { userId: user.id, accountId: account.id, categoryId: category.id };
}

async function seedTransaction(
	seed: { userId: string; accountId: string; categoryId: string },
	label: string
): Promise<string> {
	const transaction = await prisma.transaction.create({
		data: {
			userId: seed.userId,
			accountId: seed.accountId,
			categoryId: seed.categoryId,
			date: new Date('2026-06-15T00:00:00.000Z'),
			label,
			amountCents: -4_200,
			source: 'manual'
		},
		select: { id: true }
	});
	return transaction.id;
}

afterAll(async () => {
	if (createdUserIds.length > 0) {
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
});

describe('tag tenancy', () => {
	it('refuses to link one user transaction to another user tag', async () => {
		expect.assertions(4);

		const a = await seedUser();
		const b = await seedUser();
		const transactionA = await seedTransaction(a, 'Chez A');
		const tagB = await resolveTagByName(b.userId, 'Chez B');

		// The attempt: user A's session, user A's transaction, a name that already exists as user
		// B's tag. Nothing at the database level stops a link to tagB.id from existing. What stops
		// it is that resolveTagByName is userId-scoped and creates a SEPARATE tag owned by A.
		await setTransactionTags(a.userId, transactionA, ['Chez B']);

		const links = await prisma.transactionTag.findMany({
			where: { transactionId: transactionA },
			select: { tagId: true, tag: { select: { userId: true } } }
		});

		expect(links).toHaveLength(1);
		expect(links[0].tagId).not.toBe(tagB.id);
		expect(links[0].tag.userId).toBe(a.userId);
		// And user B's tag is untouched, still carrying no links.
		expect(await prisma.transactionTag.count({ where: { tagId: tagB.id } })).toBe(0);
	});

	it('reports not-found rather than tagging when the transaction belongs to someone else', async () => {
		expect.assertions(2);

		const a = await seedUser();
		const b = await seedUser();
		const transactionB = await seedTransaction(b, 'Chez B');

		expect(await setTransactionTags(a.userId, transactionB, ['Portugal'])).toBe('not-found');
		expect(await prisma.transactionTag.count({ where: { transactionId: transactionB } })).toBe(0);
	});

	it('refuses to prune a tag owned by another user', async () => {
		expect.assertions(2);

		const a = await seedUser();
		const b = await seedUser();
		const tagB = await resolveTagByName(b.userId, 'Orpheline chez B');

		// B's tag has no transactions, so only the userId conjunct stands between A and deleting it.
		expect(await pruneOrphanTags(a.userId, [tagB.id])).toBe(0);
		expect(await prisma.tag.count({ where: { id: tagB.id } })).toBe(1);
	});
});

describe('bulk tagging tenancy', () => {
	it('refuses to undo a link belonging to another user', async () => {
		expect.assertions(3);

		const a = await seedUser();
		const b = await seedUser();
		const transactionB = await seedTransaction(b, 'Chez B');

		// B tags their own transaction through the bulk path, then A attempts to undo it with the
		// exact tagId and transactionId. TransactionTag carries no userId column, so nothing in the
		// schema stops that delete: the `transaction: { userId }` conjunct in undoBulkTag is the
		// whole protection, and a fake Prisma cannot demonstrate it because a fake has no relation
		// to traverse.
		const applied = await applyTagToFilteredSet(b.userId, { userId: b.userId }, 'Portugal');
		expect(applied.outcome).toBe('ok');
		if (applied.outcome !== 'ok') return;

		expect(await undoBulkTag(a.userId, applied.tagId, [transactionB])).toBe(0);
		// And the link is still there, so the refusal was a refusal rather than a silent success.
		expect(
			await prisma.transactionTag.count({
				where: { tagId: applied.tagId, transactionId: transactionB }
			})
		).toBe(1);
	});

	it('leaves the other user tag intact when the forged undo is refused', async () => {
		expect.assertions(1);

		const a = await seedUser();
		const b = await seedUser();
		await seedTransaction(b, 'Chez B');

		const applied = await applyTagToFilteredSet(b.userId, { userId: b.userId }, 'Cible');
		if (applied.outcome !== 'ok') return;

		await undoBulkTag(a.userId, applied.tagId, []);

		// The prune runs after the delete. An empty id list must not reach it, or A would delete B's
		// tag without ever touching a link. undoBulkTag returns early for exactly this reason.
		expect(await prisma.tag.count({ where: { id: applied.tagId } })).toBe(1);
	});
});

describe('orphan pruning under concurrency', () => {
	it('never leaves a link without its tag when a prune races a tag write', async () => {
		expect.assertions(50);

		const a = await seedUser();
		const first = await seedTransaction(a, 'Premiere');
		const second = await seedTransaction(a, 'Seconde');

		// Untag the first transaction, which prunes, at the same moment the second is tagged with
		// the same name. If the emptiness condition were a read followed by a write, the prune
		// could observe zero links, then delete the tag the other request has just linked to,
		// leaving either an orphaned link or a foreign key violation depending on the engine.
		//
		// Run repeatedly: a race that fires one time in ten is still a race, and a single pass
		// proves nothing.
		for (let attempt = 0; attempt < 25; attempt++) {
			await setTransactionTags(a.userId, first, ['Portugal']);

			await Promise.all([
				setTransactionTags(a.userId, first, []),
				setTransactionTags(a.userId, second, ['Portugal'])
			]);

			// The invariant, stated as what must never be true rather than as an expected outcome:
			// every surviving link must still have its tag. Both "the tag survived with both links"
			// and "everything went" are acceptable end states; a link whose tag is gone is not.
			const links = await prisma.transactionTag.findMany({
				where: { transaction: { userId: a.userId } },
				select: { tagId: true, tag: { select: { id: true } } }
			});
			expect(links.every((link) => link.tag !== null)).toBe(true);

			const tagIds = new Set(
				(await prisma.tag.findMany({ where: { userId: a.userId }, select: { id: true } })).map(
					(tag) => tag.id
				)
			);
			expect(links.every((link) => tagIds.has(link.tagId))).toBe(true);

			// Reset for the next attempt.
			await setTransactionTags(a.userId, second, []);
		}
	}, 120_000);
});
