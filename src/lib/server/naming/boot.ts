import { prisma } from '$lib/server/db';
import { withBootBackfillLock } from '$lib/server/database/advisoryLock';
import { log, logBackfillLockWait } from '$lib/server/logging';
import { ATTRIBUTE, EVENT } from '$lib/server/logging/names';
import { hasPendingNameKeys, runNameKeyBackfill } from './backfill.ts';
import { summaryCounts } from './report.ts';

/**
 * Runs the name-key backfill once, at startup, if it has not run yet.
 *
 * Called from `hooks.server.ts`'s `init`, which adapter-node awaits before the server
 * listens, so no request is ever served against half-migrated data. Upgrading stays
 * `docker compose up -d` with no extra operator step, which is the point.
 *
 * Why not in the migration: `prisma migrate deploy` runs before any app code, so a data
 * merge expressed there would have to be hand-written SQL, restated once per database
 * provider, duplicating rules that decide what happens to financial data. Keeping it here
 * means one tested implementation for every provider.
 *
 * A failure is fatal on purpose, in line with the app's other boot checks. Serving requests
 * against rows whose keys are half-written would silently split one category in two for
 * budgets and nature mapping, which is worse than not starting. Nothing is left
 * half-applied either way: each user's merge runs in its own transaction.
 *
 * Only counts reach the log. The names themselves are the user's financial data and stay
 * out of it; the normalize-names dry run is where an operator reads the detail, on their own
 * terminal. The warning below names the in-container form first, because that is where most
 * installs read this line, and the image's entrypoint is `node` — `npm run` does not work
 * there. See docs/operations.md.
 *
 * The merge runs under a database-level lock on PostgreSQL and MySQL, because two application
 * instances sharing one database would otherwise compute and apply the same plan at the same
 * time. See server/database/advisoryLock.ts. The cheap check runs twice on purpose: once
 * outside the lock so an already-migrated database pays nothing at all, and once inside it so
 * the instance that waited does not redo work the winner just finished.
 */
export async function ensureNameKeysBackfilled(): Promise<void> {
	if (!(await hasPendingNameKeys(prisma))) return;

	await withBootBackfillLock(
		'name-keys',
		async () => {
			if (!(await hasPendingNameKeys(prisma))) return;

			log({ event: EVENT.backfillStarted, attributes: { [ATTRIBUTE.backfillName]: 'name_keys' } });
			const report = await runNameKeyBackfill({ prisma });
			const counts = summaryCounts(report);
			log({
				event: EVENT.backfillCompleted,
				attributes: {
					[ATTRIBUTE.backfillName]: 'name_keys',
					[ATTRIBUTE.backfillCount]: counts.keysWritten,
					[ATTRIBUTE.backfillUsers]: counts.users,
					[ATTRIBUTE.backfillRowsMerged]: counts.rowsMerged,
					[ATTRIBUTE.backfillRepointed]: counts.transactionsRepointed
				}
			});

			const blocked = report.users.reduce(
				(total, user) => total + user.accountMergesBlocked.length,
				0
			);
			const netWorth = report.users.reduce(
				(total, user) => total + user.netWorthCollisions.length,
				0
			);
			if (blocked > 0 || netWorth > 0) {
				log({
					event: EVENT.backfillMergesBlocked,
					attributes: {
						[ATTRIBUTE.backfillAccountGroups]: blocked,
						[ATTRIBUTE.backfillNetWorthGroups]: netWorth
					}
				});
			}
		},
		{ onWait: logBackfillLockWait }
	);
}
