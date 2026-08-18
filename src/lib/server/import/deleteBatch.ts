import { prisma } from '$lib/server/db';

/**
 * A batch and its transactions, removed together.
 *
 * ## Two callers, one implementation, and that is what the file is for
 *
 * `/imports`'s `cancel` action, where the user asks for the deletion, and `/import/columns`, where
 * a correction replaces the batch it was launched from. A second copy would drift from this one
 * silently, and the thing that would drift is a delete.
 *
 * ## THE REPLACE IS WRITE THEN DELETE, AND THE ORDER IS NOT NEGOTIABLE
 *
 * It cannot be one transaction. `persistImportedTransactions` relies on catching a unique violation
 * and carrying on with the next row, and on PostgreSQL a constraint violation aborts the enclosing
 * transaction, so the write path may never run inside one; `persist.ts` states that rule at the
 * function it applies to. The ordering is therefore the ONLY control available here, and someone
 * will otherwise reverse it reaching for atomicity in good faith.
 *
 * Write first. The doubled state does not leave the system: it leaves the journey, and survives as
 * a crash outcome, which is the one the user already knows how to repair. Delete-then-write trades
 * that for data loss, with the file held only in the browser and nothing left to re-read.
 *
 * A second and independent argument reaches the same order, from the design project's own issue on
 * the recap: « Supprimer d'abord le mauvais import parait juste et c'est un piege : le
 * recapitulatif se rejoint depuis la ligne de cet import, donc le supprimer d'abord efface la seule
 * route vers les colonnes. Corriger d'abord, supprimer ensuite. » Two independent arguments
 * reaching the same order is the strongest evidence available that the order is right, which is why
 * both are written down rather than the better one.
 *
 * ## What it destroys beyond the rows
 *
 * `TransactionSplit` and `TransactionTag` cascade from `Transaction`, so the user's own splits and
 * tags on those rows go with them. That was accepted for a deletion the user asks for, where a
 * confirmation names it. Every caller therefore has to have said so in words BEFORE calling, and
 * the replace path says it on the correction notice's control rather than in a dialog that path
 * never shows.
 */
export async function deleteImportBatch(userId: string, batchId: string): Promise<boolean> {
	// Resolved against this user before anything is written. An id that decides which rows are
	// destroyed is verified, never carried.
	const batch = await prisma.importBatch.findFirst({
		where: { id: batchId, userId },
		select: { id: true }
	});
	if (!batch) return false;

	await prisma.$transaction([
		// The transactions first, and `userId` restated on the deleteMany rather than trusted from
		// the lookup above: a filter on the rows being destroyed is not inherited from a filter on
		// the row that named them.
		prisma.transaction.deleteMany({ where: { userId, importBatchId: batch.id } }),
		prisma.importBatch.delete({ where: { id: batch.id } })
	]);
	return true;
}
