import { prisma } from '$lib/server/db';
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
 */
export async function ensureDedupeKeyHashesBackfilled(): Promise<void> {
	if (!(await hasPendingDedupeKeyHashes(prisma))) return;

	console.log('[dedupe-keys] hashing existing deduplication keys, this runs once');
	const written = await runDedupeKeyHashBackfill({ prisma });
	console.log(`[dedupe-keys] backfill complete: ${written} row(s) hashed`);
}
