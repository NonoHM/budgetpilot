import { prisma } from '$lib/server/db';
import { withBootBackfillLock } from '$lib/server/database/advisoryLock';
import { hasContestedNetWorthLines, repairContestedNetWorthLinks } from './contestedRepair.ts';

/**
 * Withdraws contested net worth links once, at startup, if any install carries them.
 *
 * The shape is copied from `naming/boot.ts` and `import/accountBoot.ts` rather than invented, and
 * one boot module per domain is the convention being followed.
 *
 * Called from `hooks.server.ts`'s `init`, which adapter-node awaits before the server listens, so
 * no request is ever served against a line two buckets are still fighting over. Upgrading stays
 * `docker compose up -d` with no extra operator step.
 *
 * The cheap check runs twice on purpose: once outside the lock, so an install with no bank
 * connection pays one narrow query and nothing else, and once inside it, so an instance that waited
 * does not redo the work the winner just finished. The lock exists because two instances sharing
 * one database would otherwise compute and apply the same repair at the same time.
 *
 * ## A failure is fatal, in line with the app's other boot checks
 *
 * Serving requests against a contested line means /net-worth shows a figure that alternates between
 * two unrelated bank balances with nothing on screen able to say which one it currently reports.
 * A false displayed figure is one of the three things this repository fixes immediately, so
 * starting anyway would be serving the defect the repair exists to remove.
 *
 * ## Counts only, never an id and never a name
 *
 * An account name is the user's own word for their bank and a net worth line is labelled by them
 * too. ASVS 5.0.0 `v5.0.0-16.2.5`, as of the 2026-08-13 assessment of commit `d9c116c`. The line
 * is written to TEACH rather than only to report: it says what was withdrawn and where to set it
 * again, because a user whose « Connecté » badge went out otherwise has no way to know why.
 */
export async function ensureNoContestedNetWorthLinks(): Promise<void> {
	if (!(await hasContestedNetWorthLines(prisma))) return;

	await withBootBackfillLock('net-worth-contested-links', async () => {
		if (!(await hasContestedNetWorthLines(prisma))) return;

		const { linesContested, cleared } = await repairContestedNetWorthLinks(prisma);
		console.warn(
			`[net-worth-links] ${linesContested} net worth account(s) were being fed by more than one ` +
				`synchronized bank account, which made their balance depend on sync order (#501). ` +
				`${cleared} link(s) withdrawn. Set the one that should feed each line again from ` +
				'Réglages > Comptes, or from Imports > Connexions bancaires.'
		);
	});
}
