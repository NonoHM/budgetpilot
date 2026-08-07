import { prisma } from '$lib/server/db';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { computeNameKey } from '$lib/server/naming/nameKey';
import {
	MAX_SPLIT_NOTE_LENGTH,
	MAX_SPLITS_PER_TRANSACTION,
	MIN_SPLITS_PER_TRANSACTION,
	normalizeSplitNote
} from '$lib/domain/allocation';

/** One part as it arrives from a client. Everything here is untrusted. */
export interface SplitInput {
	categoryId: string;
	amountCents: number;
	note?: string | null;
}

/**
 * Why a discriminated result rather than thrown errors: this is the idiom PR #119 established for
 * `TransactionScope`, and every failure below is an EXPECTED state of a form the user is filling
 * in, not an exception. It also lets the compiler force each caller to handle every refusal.
 *
 * `positions` are 0-based indices into the submitted array. They exist because the editor has to
 * be able to say "choose a category for part 2" rather than failing generically — the case the
 * design flagged as unanswerable at the drawing stage if the service could not name the part.
 *
 * `not-found` is returned for a transaction that does not exist AND for one belonging to somebody
 * else. Identical response, deliberately: the difference is exactly what an attacker would be
 * probing for.
 */
export type ReplaceSplitsResult =
	| { ok: true }
	| { ok: false; reason: 'not-found' }
	| { ok: false; reason: 'count'; count: number }
	| { ok: false; reason: 'sum'; expectedCents: number; actualCents: number }
	| { ok: false; reason: 'amount'; positions: number[] }
	| { ok: false; reason: 'category'; positions: number[] }
	| { ok: false; reason: 'note'; positions: number[] };

/**
 * Replaces a transaction's whole répartition, atomically.
 *
 * THE INVARIANT: the parts sum to the parent's amount, exactly. It is application-level because no
 * database expresses it portably across the three providers, which has two consequences worth
 * stating rather than discovering. First, it must be proven per engine, against a real database,
 * since a unit test that injects the query's result replaces the very code in question. Second,
 * **every write path must come through here** — a restore inserting with `createMany` bypasses this
 * function entirely, which is why `backup/import.ts` re-checks the same invariant on its own.
 *
 * Ordering inside the transaction is load-bearing:
 *
 *  1. `updateMany` on the PARENT, not a `findFirst`. It does two jobs a read cannot: it proves
 *     ownership (count 0 -> the same `not-found` a nonexistent id gets), and it takes a ROW LOCK
 *     held for the transaction's duration, so a concurrent write to the parent's amount serialises
 *     behind it instead of interleaving. That matters per engine: SQLite serialises writers anyway,
 *     PostgreSQL and MySQL at READ COMMITTED do not.
 *  2. The parent's `amountCents` is re-read INSIDE the transaction. A client-supplied total is
 *     never trusted, and a total read before the lock could already be stale.
 *  3. Validation, all of it, before any write.
 *  4. Delete-then-insert, inside the same transaction, so a partial répartition is never observable.
 *
 * `withConcurrentWriteRetry` must NOT be used here. It exists for idempotent upserts racing on a
 * unique constraint, and its own doc comment forbids running it inside `prisma.$transaction`
 * because PostgreSQL aborts the enclosing transaction when a constraint fires. Splits race on
 * none of that; the protection is the row lock.
 */
export async function replaceSplits(
	userId: string,
	transactionId: string,
	parts: readonly SplitInput[]
): Promise<ReplaceSplitsResult> {
	// Checked before opening a transaction: a forged request with 10 000 parts should not hold a
	// pooled connection while being refused. The same bound is re-derived from the array below,
	// so this is an early exit rather than the enforcement.
	if (parts.length < MIN_SPLITS_PER_TRANSACTION || parts.length > MAX_SPLITS_PER_TRANSACTION) {
		return { ok: false, reason: 'count', count: parts.length };
	}

	return prisma.$transaction(async (tx) => {
		const owned = await tx.transaction.updateMany({
			where: { id: transactionId, userId },
			data: { updatedAt: new Date() }
		});
		if (owned.count === 0) return { ok: false, reason: 'not-found' };

		const parent = await tx.transaction.findFirstOrThrow({
			where: { id: transactionId, userId },
			select: { amountCents: true }
		});

		const notePositions: number[] = [];
		const amountPositions: number[] = [];
		const normalized = parts.map((part, position) => {
			// Normalized BEFORE the length check, not after: stripping happens first, so a note made
			// of 200 zero-width characters is empty rather than over-long, and a note whose visible
			// length is legal is not refused for invisible ones.
			const note = normalizeSplitNote(part.note);
			if (note.length > MAX_SPLIT_NOTE_LENGTH) notePositions.push(position);

			// A part must be a non-zero integer carrying the PARENT's sign. Zero says nothing, and
			// an opposite sign is a refund or a transfer rather than an allocation — allowing one
			// would let a répartition sum correctly while containing a part that no per-category
			// total can interpret.
			if (
				!Number.isSafeInteger(part.amountCents) ||
				part.amountCents === 0 ||
				part.amountCents > 0 !== parent.amountCents >= 0
			) {
				amountPositions.push(position);
			}

			return { categoryId: part.categoryId, amountCents: part.amountCents, note, position };
		});

		if (amountPositions.length > 0)
			return { ok: false, reason: 'amount', positions: amountPositions };
		if (notePositions.length > 0) return { ok: false, reason: 'note', positions: notePositions };

		// One query for every distinct category, resolved UNDER THIS USER. Neither foreign key
		// stops a part pointing at somebody else's category; only this re-resolution does. The
		// `nameKey` comes back too so the sentinel can be refused without a second round trip.
		const requestedIds = [...new Set(normalized.map((part) => part.categoryId))];
		const resolved = await tx.category.findMany({
			where: { id: { in: requestedIds }, userId },
			select: { id: true, nameKey: true }
		});
		const sentinelKey = computeNameKey(UNCLASSIFIED_CATEGORY);
		const usable = new Set(
			resolved.filter((category) => category.nameKey !== sentinelKey).map((category) => category.id)
		);

		// A foreign id, a nonexistent id and the sentinel all land here identically. The first two
		// must be indistinguishable for the same reason `not-found` is; the sentinel joins them
		// because allocating money to "uncategorized" is meaningless and the UI never offers it.
		const categoryPositions = normalized
			.filter((part) => !usable.has(part.categoryId))
			.map((part) => part.position);
		if (categoryPositions.length > 0) {
			return { ok: false, reason: 'category', positions: categoryPositions };
		}

		const sum = normalized.reduce((total, part) => total + part.amountCents, 0);
		if (sum !== parent.amountCents) {
			return { ok: false, reason: 'sum', expectedCents: parent.amountCents, actualCents: sum };
		}

		await tx.transactionSplit.deleteMany({ where: { transactionId } });
		await tx.transactionSplit.createMany({
			data: normalized.map((part) => ({
				transactionId,
				categoryId: part.categoryId,
				amountCents: part.amountCents,
				position: part.position,
				note: part.note.length > 0 ? part.note : null
			}))
		});

		return { ok: true };
	});
}

/**
 * Answers "is this row répartie?" for the two actions that must REFUSE BY NAME rather than fail.
 *
 * The protection itself is never this function — it is the `splits: { none: {} }` conjunct on the
 * write's own `where`, which is atomic and cannot be raced. This runs only after such a write has
 * matched nothing, to decide which sentence the user reads: "transaction not found" (a row that is
 * not theirs, or is gone) or "this transaction is répartie" (a row they are looking at right now).
 * Getting that wrong is not cosmetic — the first sentence is simply false, and it sends a user
 * looking for a row that is on their screen.
 *
 * Scoped by `userId` for the usual reason: the id comes from the client, so an unscoped read would
 * let one account probe whether another's transaction is split.
 */
export async function isSplitTransaction(userId: string, transactionId: string): Promise<boolean> {
	const count = await prisma.transactionSplit.count({
		where: { transactionId, transaction: { id: transactionId, userId } }
	});
	return count > 0;
}

/**
 * Removes a transaction's répartition entirely, leaving the parent exactly as it was.
 *
 * Lossless by construction, and that is the whole reason the parent keeps its own category: nothing
 * falls back into the "to classify" pile, no figure is lost, and the transaction returns to being an
 * ordinary single-category row. A separate, explicit action — never the side effect of removing
 * parts until one is left, which the floor of two forbids anyway.
 *
 * Idempotent: clearing a transaction that has no parts succeeds. There is nothing to report, and a
 * caller cannot usefully distinguish "there were none" from "there are none now".
 */
export async function clearSplits(
	userId: string,
	transactionId: string
): Promise<{ ok: true } | { ok: false; reason: 'not-found' }> {
	return prisma.$transaction(async (tx) => {
		// Same updateMany-as-ownership-proof as above, and for the same two reasons. A bare
		// `deleteMany({ where: { transactionId } })` would delete another user's parts: the id
		// arrives from the client and TransactionSplit carries no userId to scope by.
		const owned = await tx.transaction.updateMany({
			where: { id: transactionId, userId },
			data: { updatedAt: new Date() }
		});
		if (owned.count === 0) return { ok: false, reason: 'not-found' };

		await tx.transactionSplit.deleteMany({ where: { transactionId } });
		return { ok: true };
	});
}
