import { prisma } from '$lib/server/db';
import { withBootBackfillLock } from '$lib/server/database/advisoryLock';
import { hasPendingDedupeKeyHashes, runDedupeKeyHashBackfill } from './dedupeBackfill.ts';

/**
 * Runs the backfill once, at startup, if it has not run yet.
 *
 * Called from `hooks.server.ts`'s `init` alongside the name-key backfill, so upgrading stays
 * `docker compose up -d`. A failure is fatal, in line with the app's other boot checks: a row
 * left without its hash is a row no duplicate check can see, which turns the next import into
 * a silent double of everything it already holds.
 *
 * Counts only in the log. A deduplication key contains the transaction's own label.
 *
 * Under its own database-level lock on PostgreSQL and MySQL, for the same reason the name-key
 * backfill has one: two instances sharing a database would otherwise walk the same pending rows
 * together. Its own, not shared with the name-key lock, so neither waits on work it does not
 * depend on. See server/database/advisoryLock.ts.
 */
export async function ensureDedupeKeyHashesBackfilled(): Promise<void> {
	if (!(await hasPendingDedupeKeyHashes(prisma))) return;

	await withBootBackfillLock('dedupe-keys', async () => {
		if (!(await hasPendingDedupeKeyHashes(prisma))) return;

		console.log('[dedupe-keys] hashing existing deduplication keys, this runs once');
		const written = await runDedupeKeyHashBackfill({ prisma });
		console.log(`[dedupe-keys] backfill complete: ${written} row(s) hashed`);
	});
}
