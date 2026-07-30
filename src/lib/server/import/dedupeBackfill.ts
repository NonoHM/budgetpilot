import type { PrismaClient } from '../database/types.ts';
// Relative, `.ts`-suffixed imports, like server/naming/backfill.ts: this module is also
// imported by plain Node (no Vite, no `$lib` alias) so a backfill can be run and inspected
// outside the app.
import { LONG_TRANSACTION_OPTIONS } from '../dbTransaction.ts';
import { computeDedupeKeyHash } from './dedupeKey.ts';

/**
 * Fills `Transaction.dedupeKeyHash` on rows imported before the column existed.
 *
 * Much simpler than the name-key backfill next door, and for one reason: there is nothing to
 * merge. `dedupeKey` is already unique per user, and the hash is one-to-one with it, so no two
 * rows can collapse into one. Every row keeps its identity; only the value the app compares
 * changes.
 *
 * Rows are read in batches and written by id. Never by re-matching the raw key in SQL: that
 * equality is the database's, and deciding it in the app is the entire point of the column.
 */
const READ_BATCH = 1000;
const WRITE_BATCH = 500;

export interface DedupeKeyHashBackfillOptions {
	prisma: PrismaClient;
	onProgress?: (message: string) => void;
}

/**
 * Gate for the boot path: is any row still missing its hash?
 *
 * `findFirst`, not `count`: no index leads with `dedupeKeyHash`, so this predicate is answered
 * by walking the transaction table. Stopping at the first hit keeps the work bounded in the
 * case that matters, and the case that runs forever after the backfill is done still costs one
 * scan per start. Worth knowing before this meets a database across a socket.
 */
export async function hasPendingDedupeKeyHashes(prisma: PrismaClient): Promise<boolean> {
	const pending = await prisma.transaction.findFirst({
		where: { dedupeKey: { not: null }, dedupeKeyHash: null },
		select: { id: true }
	});
	return pending !== null;
}

/** Returns how many rows were given a hash. */
export async function runDedupeKeyHashBackfill(
	options: DedupeKeyHashBackfillOptions
): Promise<number> {
	const { prisma } = options;
	let written = 0;

	// Batched rather than one unbounded read: this walks a full transaction history, which is
	// exactly the scan the app removed everywhere else for memory reasons.
	//
	// No cursor, deliberately. A row leaves the "still missing its hash" filter the moment this
	// loop writes it, so a cursor would point at a row the next query no longer returns and the
	// walk would stop after one page. Re-asking for the first N pending rows is correct here
	// precisely because the set shrinks by exactly what each pass writes.
	for (;;) {
		const rows = await prisma.transaction.findMany({
			where: { dedupeKey: { not: null }, dedupeKeyHash: null },
			select: { id: true, dedupeKey: true },
			orderBy: { id: 'asc' },
			take: READ_BATCH
		});
		if (rows.length === 0) break;
		const writtenBefore = written;

		// Grouped by hash so identical keys share one statement. Distinct values dominate here,
		// unlike the name keys, so this mostly stays one statement per row: correct either way.
		const idsByHash = new Map<string, string[]>();
		for (const row of rows) {
			if (!row.dedupeKey) continue;
			const hash = computeDedupeKeyHash(row.dedupeKey);
			const bucket = idsByHash.get(hash);
			if (bucket) bucket.push(row.id);
			else idsByHash.set(hash, [row.id]);
		}

		await prisma.$transaction(async (tx) => {
			for (const [hash, ids] of idsByHash) {
				for (let start = 0; start < ids.length; start += WRITE_BATCH) {
					const result = await tx.transaction.updateMany({
						where: { id: { in: ids.slice(start, start + WRITE_BATCH) } },
						data: { dedupeKeyHash: hash }
					});
					written += result.count;
				}
			}
		}, LONG_TRANSACTION_OPTIONS);

		// The loop only terminates because every pass shrinks the pending set, so a pass that
		// wrote nothing needs checking: re-asking would otherwise return the same page forever.
		//
		// "Wrote nothing" is not the same as "made no progress", though, and this runs at boot
		// where the difference decides whether the app starts. Rows can legitimately vanish
		// between the read and the write (a concurrent delete, a backup restore), and MySQL
		// reports zero affected rows when an update sets a value a row already holds. Both
		// leave the page genuinely handled. So ask whether those specific rows are still
		// pending, and only refuse to continue if they are.
		if (written === writtenBefore) {
			const stillPending = await prisma.transaction.count({
				where: {
					id: { in: rows.map((row) => row.id) },
					dedupeKey: { not: null },
					dedupeKeyHash: null
				}
			});
			if (stillPending > 0) {
				throw new Error(
					`[dedupe-keys] backfill stalled: ${stillPending} row(s) still missing a hash could not be written`
				);
			}
		}

		options.onProgress?.(`Hashed ${written} deduplication key(s)`);
	}

	return written;
}
