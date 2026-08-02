import { prisma } from '$lib/server/db';
import type { Prisma } from '../database/types.ts';
import { forEachTransactionBatch } from '$lib/server/transactions/batch';
import { isForeignKeyViolation } from '$lib/server/database/upsert';
import { MAX_TAGS_PER_TRANSACTION } from '$lib/domain/tags';
import { pruneOrphanTags, resolveTagByName, TagVanishedError } from './service';

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
	| { outcome: 'too-many'; matched: number }
	| { outcome: 'over-tag-cap'; overCapCount: number };

/** Attempts in total, not retries. Same bound and same reason as replaceLinks in service.ts. */
const MAX_LINK_ATTEMPTS = 3;

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
	let overflowed = false;
	await forEachTransactionBatch(where, { id: true }, (rows) => {
		for (const row of rows) matchedIds.push(row.id);
		// The count above and this scan are two separate reads, so a concurrent import between them
		// can push the real set past the cap. Stopping here matters because the undo payload travels
		// back through normalizeIdList, whose split limit is MAX_TRANSACTION_ID_FILTER: one id over
		// and the undo silently truncates, leaving a row tagged with no way to reverse it.
		if (matchedIds.length > MAX_BULK_TAG_TRANSACTIONS) {
			overflowed = true;
			return false;
		}
	});
	if (overflowed) return { outcome: 'too-many', matched: matchedIds.length };

	// No tag for an empty set. Creating one would leave a row the auto-GC reclaims only on the next
	// unlink, which for a tag that never had a link never comes.
	if (matchedIds.length === 0) {
		return { outcome: 'ok', tagId: '', tagName, linkedTransactionIds: [] };
	}

	// Retried on a foreign-key violation, for the race service.ts documents as MEASURED rather than
	// predicted: resolveTagByName can create a tag with zero links, and a concurrent pruneOrphanTags
	// then deletes it legitimately, because at that instant `transactions: { none: {} }` genuinely
	// holds. The insert below is left referencing a row that no longer exists and fails with P2003.
	//
	// This file reimplemented that resolve-then-link sequence without the protection, and a review
	// caught it. Recovery requires RE-RESOLVING, not re-inserting: the tag row is gone, so retrying
	// the insert alone would fail identically forever. withConcurrentWriteRetry does not help here
	// either, since P2003 is deliberately absent from its transient allowlist.
	for (let attempt = 1; ; attempt++) {
		let tag: { id: string };
		try {
			tag = await resolveTagByName(userId, tagName);
		} catch (caught) {
			// Same race, caught at the resolve rather than at the insert: on PostgreSQL the upsert
			// can return without an id when a prune deletes the row mid-statement. Re-resolving
			// recreates it. See resolveTagByName.
			if (!(caught instanceof TagVanishedError) || attempt >= MAX_LINK_ATTEMPTS) throw caught;
			continue;
		}

		// The diff is computed BEFORE the write, and that ordering is the whole point. Reading the
		// existing links afterwards could not distinguish a link this action created from one that
		// was already there, so the undo payload would untag rows the user tagged some other day.
		const existing = await prisma.transactionTag.findMany({
			where: { tagId: tag.id, transactionId: { in: matchedIds } },
			select: { transactionId: true }
		});
		const alreadyLinked = new Set(existing.map((link) => link.transactionId));
		const linkedTransactionIds = matchedIds.filter((id) => !alreadyLinked.has(id));

		if (linkedTransactionIds.length === 0) {
			return { outcome: 'ok', tagId: tag.id, tagName, linkedTransactionIds };
		}

		// The per-transaction cap, counted rather than assumed. service.ts warns by name that any
		// future "add one tag" path must COUNT the existing rows, because setTransactionTags only
		// holds the cap by REPLACING; this path adds. Without it a transaction could pass
		// MAX_TAGS_PER_TRANSACTION, which locks its editor (the picker refuses to save a set it
		// considers over the limit) and produces an export the app's own restore validator rejects,
		// since that validator's ceiling is transactions x MAX_TAGS_PER_TRANSACTION.
		const counts = await prisma.transactionTag.groupBy({
			by: ['transactionId'],
			where: { transactionId: { in: linkedTransactionIds } },
			_count: { tagId: true }
		});
		const overCapCount = counts.filter(
			(row) => row._count.tagId >= MAX_TAGS_PER_TRANSACTION
		).length;
		// Refused whole rather than as a prefix, like every other refusal here: a partial bulk edit
		// is invisible to the user and its undo payload would describe only part of what changed.
		if (overCapCount > 0) return { outcome: 'over-tag-cap', overCapCount };

		try {
			// Only the genuinely new pairs: re-inserting an existing one violates the composite
			// primary key and would fail the whole action. This is also what makes the refusal
			// message's promise true, that applying a tag twice does not duplicate it.
			await prisma.transactionTag.createMany({
				data: linkedTransactionIds.map((transactionId) => ({ transactionId, tagId: tag.id }))
			});
		} catch (caught) {
			if (!isForeignKeyViolation(caught) || attempt >= MAX_LINK_ATTEMPTS) throw caught;
			continue;
		}

		return { outcome: 'ok', tagId: tag.id, tagName, linkedTransactionIds };
	}
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
