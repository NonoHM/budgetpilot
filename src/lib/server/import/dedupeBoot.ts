import { prisma } from '$lib/server/db';
import { withBootBackfillLock } from '$lib/server/database/advisoryLock';
import { hasPendingDedupeKeyHashes, runDedupeKeyHashBackfill } from './dedupeBackfill.ts';
import { hasPendingDedupeKeyVersions, runDedupeKeyRecompute } from './dedupeRecomputeBackfill.ts';

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

/**
 * Carries every stored deduplication key to the version this build writes.
 *
 * Runs AFTER `ensureDedupeKeyHashesBackfilled`, and the order is load bearing: a row with no hash
 * is invisible to every duplicate check, and the recompute must not walk rows the older backfill
 * has not reached.
 *
 * Its own lock, not shared with the hash backfill, for the same reason that one has its own:
 * neither should wait on work it does not depend on.
 *
 * A failure is fatal, in line with the app's other boot checks. A half-recomputed table is safe to
 * re-run (the unit of work is a whole account-day group), so the honest response to a failure is to
 * refuse to serve rather than to start on a table nothing has finished carrying.
 *
 * Reports per batch rather than only at the end, because a boot that takes a minute with no output
 * is indistinguishable from a hung one and `docker compose up -d` gives an operator no other window
 * onto it. Counts only, never a key: a deduplication key contains the transaction's own label.
 */
export async function ensureDedupeKeysAtCurrentVersion(): Promise<void> {
	if (!(await hasPendingDedupeKeyVersions(prisma))) return;

	await withBootBackfillLock('dedupe-key-version', async () => {
		if (!(await hasPendingDedupeKeyVersions(prisma))) return;

		console.log(
			'[dedupe-keys] recomputing deduplication keys to the current version, this runs once'
		);
		const { rewritten, unkeyed } = await runDedupeKeyRecompute({
			prisma,
			onProgress: (message) => console.log(`[dedupe-keys] ${message}`)
		});
		console.log(
			`[dedupe-keys] recompute complete: ${rewritten} key(s) rewritten, ${unkeyed} row(s) left unkeyed for want of a direction`
		);
	});
}
