import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import {
	withConcurrentWriteRetry,
	isUniqueConstraintViolation,
	isForeignKeyViolation
} from '$lib/server/database/upsert';
import {
	normalizeTagName,
	pickTagColorToken,
	isTagColorToken,
	MAX_TAGS_PER_TRANSACTION,
	type TagColorToken
} from '$lib/domain/tags';

/**
 * Get-or-create for a tag, matching on the folded name.
 *
 * Deliberately the same shape as resolveCategoryByName (server/categories/resolve.ts), including
 * the empty `update: {}` and the retry wrapper it forces. Read that function's comment before
 * changing this one: the reasoning about why an upsert on the key is not a read-then-write, and
 * why the empty update needs withConcurrentWriteRetry, applies here unchanged.
 *
 * `update: {}` means an existing tag keeps the spelling the user chose. Typing "PORTUGAL" on a
 * second transaction must not rewrite the tag they named "Portugal".
 *
 * The colour is assigned here and only here, at creation, from the nameKey. It is never
 * recomputed: a rename must not change the colour the user has learned to recognise, which is
 * why the column is persisted rather than derived.
 */
export async function resolveTagByName(userId: string, rawName: string): Promise<{ id: string }> {
	const name = normalizeTagName(rawName);
	if (!name) throw new Error('resolveTagByName requires a non-empty name');
	const nameKey = computeNameKey(name);

	return withConcurrentWriteRetry(() =>
		prisma.tag.upsert({
			where: { userId_nameKey: { userId, nameKey } },
			update: {},
			create: { userId, name, nameKey, colorToken: pickTagColorToken(nameKey) },
			select: { id: true }
		})
	);
}

/**
 * Rename, writing `name` and `nameKey` in ONE update so the two can never diverge.
 *
 * Returns 'duplicate' rather than merging when the target name already exists. Merging two tags
 * is silent, irreversible movement of data across a boundary the user drew, and it needs its own
 * decision. See the spec's section 6.7.
 */
export async function renameTag(
	userId: string,
	tagId: string,
	rawName: string
): Promise<'ok' | 'not-found' | 'duplicate' | 'empty-name'> {
	const name = normalizeTagName(rawName);
	if (!name) return 'empty-name';

	try {
		// updateMany with (id, userId), not update by id: a forged id belonging to another account
		// comes back as count 0, indistinguishable from an id that never existed. Same pattern as
		// undoStreamAction.
		const result = await prisma.tag.updateMany({
			where: { id: tagId, userId },
			data: { name, nameKey: computeNameKey(name) }
		});
		return result.count === 0 ? 'not-found' : 'ok';
	} catch (caught) {
		if (isUniqueConstraintViolation(caught)) return 'duplicate';
		throw caught;
	}
}

export async function recolorTag(
	userId: string,
	tagId: string,
	colorToken: string
): Promise<'ok' | 'not-found' | 'invalid-color'> {
	// Checked before any query: the closed set is the only thing keeping an inaccessible colour
	// out of the column, and the contrast gate only covers colours that are in it.
	if (!isTagColorToken(colorToken)) return 'invalid-color';

	const result = await prisma.tag.updateMany({
		where: { id: tagId, userId },
		data: { colorToken }
	});
	return result.count === 0 ? 'not-found' : 'ok';
}

export async function deleteTag(userId: string, tagId: string): Promise<'ok' | 'not-found'> {
	// Links cascade from the tag, so nothing needs deleting first.
	const result = await prisma.tag.deleteMany({ where: { id: tagId, userId } });
	return result.count === 0 ? 'not-found' : 'ok';
}

export async function listTagsWithCounts(
	userId: string
): Promise<
	Array<{ id: string; name: string; colorToken: TagColorToken; transactionCount: number }>
> {
	const tags = await prisma.tag.findMany({
		where: { userId },
		orderBy: { name: 'asc' },
		select: {
			id: true,
			name: true,
			colorToken: true,
			_count: { select: { transactions: true } }
		}
	});
	return tags.map((tag) => ({
		id: tag.id,
		name: tag.name,
		// The column is a plain String; the closed set lives in the domain. Anything outside it
		// cannot have been written by this app, so falling back keeps the type honest without
		// throwing on a row a future migration might touch.
		colorToken: isTagColorToken(tag.colorToken) ? tag.colorToken : 'clay',
		transactionCount: tag._count.transactions
	}));
}

/**
 * Replaces a transaction's tag set with `names`.
 *
 * Ownership is established by reading the transaction under (id, userId) FIRST. Neither foreign
 * key on TransactionTag prevents linking user A's transaction to user B's tag, so this read and
 * the userId-scoped resolves below are the whole protection. A test attempts the forbidden link
 * against a real engine in tags.db-smoke.ts rather than asserting it from this comment.
 *
 * The cap is applied to the DE-DUPLICATED set. Eleven spellings of one name are one tag, and
 * refusing them would be a false refusal on a legal edit.
 *
 * Note this is a REPLACE, so the resulting count is exactly `names.length` and the cap holds by
 * construction. That matters because the backup validator's bound on transactionTags is
 * aggregate rather than per-transaction, so a restored transaction can legitimately arrive
 * carrying more than MAX_TAGS_PER_TRANSACTION links. Any future "add one tag" path must COUNT
 * the existing rows instead of assuming the cap already holds; this function does not, because
 * replacing makes the question moot.
 */
export async function setTransactionTags(
	userId: string,
	transactionId: string,
	rawNames: string[]
): Promise<'ok' | 'not-found' | 'too-many'> {
	// De-duplicated by the FOLDED key, not by the display string. "Portugal", "portugal" and
	// "PORTUGAL" are one tag as far as the unique constraint is concerned, so counting them as
	// three would refuse a legal edit at the cap and fire three upserts that all resolve to the
	// same row. First spelling wins, matching resolveTagByName's empty `update: {}`.
	const byKey = new Map<string, string>();
	for (const raw of rawNames) {
		const name = normalizeTagName(raw);
		if (!name) continue;
		const key = computeNameKey(name);
		if (!byKey.has(key)) byKey.set(key, name);
	}
	const names = [...byKey.values()];
	if (names.length > MAX_TAGS_PER_TRANSACTION) return 'too-many';

	const transaction = await prisma.transaction.findFirst({
		where: { id: transactionId, userId },
		select: { id: true }
	});
	if (!transaction) return 'not-found';

	// Retried on a foreign-key violation, and that is a MEASURED requirement rather than a
	// precaution. The auto-GC race was run against a real engine (tags.db-smoke.ts) and the
	// design's prediction turned out to be wrong in an instructive way.
	//
	// The claim was that putting the emptiness condition inside the DELETE means a concurrent
	// tagging request "loses the delete rather than orphaning a link". The first half is true and
	// the second does not follow. The window is between this request RESOLVING a tag and INSERTING
	// its link: at that instant the tag genuinely has no transactions, so `transactions: { none: {} }`
	// is satisfied and a concurrent prune deletes it legitimately. This request then inserts a link
	// to a row that no longer exists and fails with P2003. No orphan is created, so the invariant
	// the design cared about does hold; what it costs is a crash on a perfectly ordinary action.
	//
	// withConcurrentWriteRetry does NOT cover this: P2003 is not a transient write conflict and is
	// deliberately absent from its allowlist. The retry belongs here, around resolve-and-link
	// together, because recovery requires RE-RESOLVING (the upsert recreates the pruned tag) and
	// not merely re-inserting. Idempotent by construction: the block re-reads the current links and
	// recomputes the diff, so a second pass lands where one would have.
	//
	// Observed on SQLite, which serializes writers, so this is not an exotic multi-engine edge.
	const removed = await replaceLinks(userId, transactionId, names);
	// Silent and unconfirmed by design: untagging the last transaction must never surface a "your
	// tag was deleted" message. A real delete, not a soft one. A tag with no transactions carries
	// no information worth preserving, and a real delete is what makes retyping the same name a
	// clean insert rather than a collision with a remnant.
	await pruneOrphanTags(userId, removed);

	return 'ok';
}

/** Attempts in total, not retries. See the race described at the call site. */
const MAX_LINK_ATTEMPTS = 3;

/**
 * Resolves `names`, diffs them against the transaction's current links, writes the difference,
 * and returns the tag ids that were unlinked.
 *
 * Separate from setTransactionTags only so the retry has something to re-run. Idempotent by
 * construction: it re-reads the current links and recomputes the diff on every attempt, so a
 * second pass lands exactly where one would have.
 */
async function replaceLinks(
	userId: string,
	transactionId: string,
	names: string[]
): Promise<string[]> {
	for (let attempt = 1; ; attempt++) {
		// Outside any $transaction on purpose: resolveTagByName wraps an upsert in
		// withConcurrentWriteRetry, and that must never run inside an interactive transaction.
		// PostgreSQL aborts the enclosing transaction when a constraint fires, so the retry would
		// fail on a different error and take every later statement with it. See
		// server/database/upsert.ts.
		const resolved = await Promise.all(names.map((name) => resolveTagByName(userId, name)));
		const nextTagIds = new Set(resolved.map((tag) => tag.id));

		const existing = await prisma.transactionTag.findMany({
			where: { transactionId },
			select: { tagId: true }
		});
		const currentTagIds = new Set(existing.map((link) => link.tagId));

		const removed = [...currentTagIds].filter((id) => !nextTagIds.has(id));
		const added = [...nextTagIds].filter((id) => !currentTagIds.has(id));

		// INSERT BEFORE DELETE, and the order is load-bearing in two ways that only appear once
		// the retry above can fire.
		//
		// Deleting first means a retried attempt re-reads the links, finds the removed ones
		// already gone, computes an EMPTY removal set, and hands pruneOrphanTags nothing. The tag
		// the user just unlinked then survives with zero transactions, which is exactly the state
		// the auto-GC exists to prevent.
		//
		// Deleting first also makes a hard failure destructive: three failed attempts would leave
		// the old links deleted and the new ones never written, so a failed edit would lose data
		// rather than being a no-op.
		//
		// The transient state between the insert and the delete can briefly exceed
		// MAX_TAGS_PER_TRANSACTION. That is invisible and harmless: the cap is not a database
		// constraint and nothing reads this transaction's links mid-request.
		if (added.length > 0) {
			try {
				// Only the genuinely new links: re-inserting one that already exists would violate
				// the composite primary key and fail the whole edit.
				await prisma.transactionTag.createMany({
					data: added.map((tagId) => ({ transactionId, tagId }))
				});
			} catch (caught) {
				if (!isForeignKeyViolation(caught) || attempt >= MAX_LINK_ATTEMPTS) throw caught;
				// Only the TAG side of the pair is a race. A transaction that vanished mid-edit is a
				// real outcome the caller already knows how to report, not contention, so retrying
				// it would turn a `not-found` into three wasted rounds and a 500.
				const stillThere = await prisma.transaction.findFirst({
					where: { id: transactionId, userId },
					select: { id: true }
				});
				if (!stillThere) throw caught;
				continue;
			}
		}

		if (removed.length > 0) {
			await prisma.transactionTag.deleteMany({
				where: { transactionId, tagId: { in: removed } }
			});
		}
		return removed;
	}
}

/**
 * Deletes any of `tagIds` that now have no transactions.
 *
 * The emptiness condition lives INSIDE the DELETE rather than in a preceding read, so a request
 * tagging one of these at the same moment loses the delete instead of orphaning a link. That is
 * the argument; it is not the evidence. tags.db-smoke.ts runs it concurrently against PostgreSQL
 * and MySQL, because this project has learned that a sound-sounding claim about concurrency is
 * exactly the kind that turns out false on an engine SQLite's single writer never exercises.
 */
export async function pruneOrphanTags(userId: string, tagIds: string[]): Promise<number> {
	if (tagIds.length === 0) return 0;

	const result = await prisma.tag.deleteMany({
		where: { id: { in: tagIds }, userId, transactions: { none: {} } }
	});
	return result.count;
}
