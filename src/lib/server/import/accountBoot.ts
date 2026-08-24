import { prisma } from '$lib/server/db';
import { withBootBackfillLock } from '$lib/server/database/advisoryLock';
import { hasPendingStatementAccounts, runStatementAccountBackfill } from './accountBackfill.ts';

/**
 * Names the import buckets and files their batches, once, at startup.
 *
 * A file of its own rather than a third function in `dedupeBoot.ts`, which is where the plan for
 * this work put it. `dedupeBoot.ts` is about deduplication keys and this is about account metadata;
 * `naming/boot.ts` is the convention being followed, one boot module per domain. The deviation is
 * recorded here rather than made silently, because a plan is not a reason.
 *
 * ## Ordering, and it is load bearing in one direction only
 *
 * Runs AFTER `ensureDedupeKeysAtCurrentVersion`. The recompute READS `accountId` as a key field and
 * this backfill never changes one: it writes `Account.institution`, `Account.name`,
 * `Account.nameKey` and `ImportBatch.accountId`, none of which the key touches. So the two are
 * independent in content, and the order is chosen so that the pass which CAN rewrite keys finishes
 * before the pass which must not.
 *
 * That independence is the whole design and it is asserted from outside, in
 * `accountIdSurvival.db-smoke.ts`: the v3 key carries `Account.id` verbatim and the bucket already
 * IS an `Account` row, so promoting it rewrites zero keys. A new table with fresh ids would have
 * made every stored key false.
 *
 * ## The rest of the shape, copied from its two siblings rather than invented
 *
 * A failure is fatal, in line with the app's other boot checks: serving requests against
 * half-named accounts would show a user two accounts where they have one. Nothing is left half
 * applied, because each batch of rows runs in its own transaction and the pass is idempotent.
 *
 * The cheap check runs twice on purpose, once outside the lock so an already-migrated database pays
 * nothing at all, and once inside it so the instance that waited does not redo the winner's work.
 * The lock exists because two application instances sharing one database would otherwise apply the
 * same plan at the same time.
 *
 * Reports per pass rather than only at the end, because a boot that takes a minute with no output
 * is indistinguishable from a hung one and `docker compose up -d` gives an operator no other window
 * onto it. COUNTS ONLY, never a name: an account name is the user's own word for their bank, and an
 * import batch's file name is the name of a file on their machine. ASVS 5.0.0 16.2.5.
 */
export async function ensureStatementAccountsBackfilled(): Promise<void> {
	if (!(await hasPendingStatementAccounts(prisma))) return;

	await withBootBackfillLock('statement-accounts', async () => {
		if (!(await hasPendingStatementAccounts(prisma))) return;

		console.log('[statement-accounts] naming import buckets and filing their batches, runs once');
		const { accountsNamed, batchesFiled } = await runStatementAccountBackfill({
			prisma,
			onProgress: (message) => console.log(`[statement-accounts] ${message}`)
		});
		console.log(
			`[statement-accounts] complete: ${accountsNamed} account(s) named, ${batchesFiled} batch(es) filed`
		);
	});
}
