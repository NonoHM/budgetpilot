import { prisma } from '$lib/server/db';
import type { Prisma } from '../database/types.ts';
import { forEachTransactionBatch } from '$lib/server/transactions/batch';
import { pruneOrphanTags, resolveTagByName } from './service';

/**
 * How many transactions one bulk action may tag.
 *
 * A SEPARATE constant from MAX_TRANSACTION_ID_FILTER, not an import of it, following the precedent
 * that constant's own comment sets: how many rows one action may tag is a domain fact about what a
 * user can reasonably confirm in a dialog, while how many ids an `IN (...)` may carry is a property
 * of the query layer. Two facts that happen to share a number today.
 *
 * They are not independent, though, and bulk.spec.ts asserts the relation rather than the equality:
 * the undo payload is the list of ids this action linked, and it travels back through the same
 * id-list parser. If this cap ever exceeded that one, an undo would silently truncate and leave
 * rows tagged with no way back. That is the failure worth preventing.
 */
export const MAX_BULK_TAG_TRANSACTIONS = 250;

export type BulkTagResult =
	| { outcome: 'ok'; tagId: string; tagName: string; linkedTransactionIds: string[] }
	| { outcome: 'too-many'; matched: number };

/**
 * Applies one tag to every transaction matching `where`.
 *
 * `where` must come from the SAME parser the list's own load uses, never from a client-supplied id
 * list: the count the user confirmed and the set actually written then have one source, and a
 * forged payload cannot widen the set.
 *
 * REFUSES above the cap rather than applying a prefix. A partial bulk edit is the worst outcome
 * available here: the user cannot see which rows were touched, and the undo payload would describe
 * only part of what changed.
 *
 * Returns the ids it NEWLY linked, which is what makes the undo exact. A row that already carried
 * the tag before this action must survive the undo, because untagging it would destroy a decision
 * the user made earlier and never asked to reverse.
 */
export async function applyTagToFilteredSet(
	userId: string,
	where: Prisma.TransactionWhereInput,
	tagName: string
): Promise<BulkTagResult> {
	// Counted before anything is collected or created, so a refusal leaves no trace at all: no tag
	// row, no links. Otherwise a user who narrows their filter and retries would be working against
	// a state their first, refused attempt had already half-changed.
	const matched = await prisma.transaction.count({ where });
	if (matched > MAX_BULK_TAG_TRANSACTIONS) return { outcome: 'too-many', matched };

	// Batched rather than one findMany, and bounded by the cap above, so a pathological filter never
	// materialises an unbounded id array. Same reasoning as the restore-timeout work.
	const matchedIds: string[] = [];
	await forEachTransactionBatch(where, { id: true }, (rows) => {
		for (const row of rows) matchedIds.push(row.id);
	});

	// No tag for an empty set. Creating one would leave a row the auto-GC reclaims only on the next
	// unlink, which for a tag that never had a link never comes.
	if (matchedIds.length === 0) {
		return { outcome: 'ok', tagId: '', tagName, linkedTransactionIds: [] };
	}

	const tag = await resolveTagByName(userId, tagName);

	// The diff is computed BEFORE the write, and that ordering is the whole point. Reading the
	// existing links afterwards could not distinguish a link this action created from one that was
	// already there, so the undo payload would untag rows the user tagged some other day.
	const existing = await prisma.transactionTag.findMany({
		where: { tagId: tag.id, transactionId: { in: matchedIds } },
		select: { transactionId: true }
	});
	const alreadyLinked = new Set(existing.map((link) => link.transactionId));
	const linkedTransactionIds = matchedIds.filter((id) => !alreadyLinked.has(id));

	if (linkedTransactionIds.length > 0) {
		// Only the genuinely new pairs: re-inserting an existing one violates the composite primary
		// key and would fail the whole action. This is also what makes the refusal message's promise
		// true, that applying a tag twice does not duplicate it.
		await prisma.transactionTag.createMany({
			data: linkedTransactionIds.map((transactionId) => ({ transactionId, tagId: tag.id }))
		});
	}

	return { outcome: 'ok', tagId: tag.id, tagName, linkedTransactionIds };
}

/**
 * Removes exactly the links a bulk action created, then prunes the tag if that emptied it.
 *
 * Idempotent: a second undo deletes nothing, because the first already did. That matters because
 * the banner carrying it survives a reload.
 *
 * Scoped through `transaction: { userId }` because TransactionTag has no userId column of its own.
 * That relation conjunct is the entire tenancy guarantee for this delete, and tags.db-smoke.ts
 * attempts the cross-account version against real engines rather than trusting this comment.
 */
export async function undoBulkTag(
	userId: string,
	tagId: string,
	transactionIds: string[]
): Promise<number> {
	// Returns early rather than falling through to the prune. An empty `in` deletes nothing, which
	// is harmless, but the prune after it is not: it would delete a tag the user still has, having
	// removed none of its links.
	if (transactionIds.length === 0) return 0;

	const result = await prisma.transactionTag.deleteMany({
		where: {
			tagId,
			transactionId: { in: transactionIds },
			transaction: { userId }
		}
	});

	// Unconditional, and cheap: pruneOrphanTags puts the emptiness test inside its own DELETE, so
	// asking it after an undo that removed nothing is a no-op rather than a risk.
	await pruneOrphanTags(userId, [tagId]);

	return result.count;
}
