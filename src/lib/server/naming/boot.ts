import { prisma } from '$lib/server/db';
import { hasPendingNameKeys, runNameKeyBackfill } from './backfill.ts';
import { renderSummaryLine } from './report.ts';

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
 * out of it; `npm run db:normalize-names -- --dry-run` is where an operator reads the
 * detail, on their own terminal.
 */
export async function ensureNameKeysBackfilled(): Promise<void> {
	if (!(await hasPendingNameKeys(prisma))) return;

	console.log('[name-keys] backfilling name keys, this runs once');
	const report = await runNameKeyBackfill({ prisma });
	console.log(renderSummaryLine(report));

	const blocked = report.users.reduce((total, user) => total + user.accountMergesBlocked.length, 0);
	const netWorth = report.users.reduce((total, user) => total + user.netWorthCollisions.length, 0);
	if (blocked > 0 || netWorth > 0) {
		console.warn(
			`[name-keys] ${blocked} account group(s) and ${netWorth} net worth account group(s) have ` +
				'names that now read as duplicates and were left untouched. Run ' +
				'"npm run db:normalize-names -- --dry-run" to see which ones.'
		);
	}
}
