import type { PrismaClient } from '../database/types.ts';
// Relative, `.ts`-suffixed imports, like `naming/backfill.ts` and `import/dedupeRecomputeBackfill.ts`:
// this module is also importable by plain Node (no Vite, no `$lib` alias) so a repair can be run
// and inspected outside the app.
import {
	accountsToUnlinkForContest,
	contestedNetWorthLines,
	type NetWorthLinkRow
} from '../../domain/netWorthLink.ts';

/**
 * Withdraws the net worth links of installs that already carry a contested line.
 *
 * ## Why this is app code and not a migration, which is a deviation from #505 and is deliberate
 *
 * `prisma migrate deploy` wraps NOTHING in a transaction on any engine, which is why every backfill
 * in this repository is boot-time app code rather than SQL. Two further reasons apply here and
 * either would be enough on its own:
 *
 *   * **A migration would be a second expression of D4**, in SQL, restated once per provider, with
 *     MySQL needing a derived table where the other two take a correlated subquery. Three
 *     hand-written statements of one rule about money is exactly the divergence #501 was.
 *   * **No CI job applies a migration to a database that already holds rows.** Both db-matrix legs
 *     and `sqlite-migrations` are fresh installs, so a data migration can only be verified by hand,
 *     per engine, once. This runs through the ordinary three-engine `db-smoke` suite on every push
 *     instead, which is the difference between a repair that is tested and a repair that was tested.
 *
 * ## Idempotent, and it is a property rather than a hope
 *
 * The set to clear is a pure function of the rows read, and clearing it removes every row from that
 * set. So a second pass reads a row set with no contested line, `accountsToUnlinkForContest`
 * returns nothing, and `cleared` is 0. That is a stronger claim than "no error", and
 * `contestedRepair.db-smoke.ts` asserts the second pass rather than describing it.
 *
 * ## What it deliberately does not do
 *
 * It deletes nothing: no bucket, no transaction, no net worth account and no snapshot. The history
 * already recorded against a line is untouched, and only the claim that a live bank feeds it is
 * withdrawn. It touches no other column, so nothing that joins on account identity can move.
 */

/** What one pass did. Counts only: an account name is the user's own word for their bank. */
export interface ContestedLinkRepairReport {
	/** Net worth lines that more than one synchronized bucket was feeding. */
	linesContested: number;
	/** Buckets whose link was withdrawn. */
	cleared: number;
}

/**
 * Every bucket that could take part in a contest, as the rule sees them.
 *
 * NOT SCOPED BY USER, and that is the same decision `link.ts` makes at the write: a net worth line
 * is one line whoever points at it, so a count that partitioned by tenant would report no contest
 * for the one case where two tenants' buckets feed one line. That state is a corruption no path
 * should produce, and if it exists it is writing two balances into that line today. Reading it
 * whole is what lets the repair see it.
 *
 * The read is narrowed to rows that could matter at all - synchronized AND linked - so an install
 * with no bank connection reads nothing and pays nothing.
 */
async function readParticipatingRows(prisma: PrismaClient): Promise<NetWorthLinkRow[]> {
	const rows = await prisma.account.findMany({
		where: { bankConnectionId: { not: null }, netWorthAccountId: { not: null } },
		select: { id: true, netWorthAccountId: true }
	});
	return rows.map((row) => ({
		accountId: row.id,
		netWorthAccountId: row.netWorthAccountId,
		// True by construction of the `where` above, and stated rather than read back from a column
		// this query already filtered on. The rule is about participation; the column is how the
		// server knows, and translating it once at the edge is what keeps the rule free of Prisma.
		synchronized: true
	}));
}

/** Whether anything needs repairing. The cheap check the boot module runs outside its lock. */
export async function hasContestedNetWorthLines(prisma: PrismaClient): Promise<boolean> {
	return contestedNetWorthLines(await readParticipatingRows(prisma)).length > 0;
}

/**
 * Clears every link on every contested line, in ONE transaction.
 *
 * One transaction rather than one per account, because the unit of correctness is the GROUP: a
 * process dying between two clears of one group would leave that line fed by exactly one bucket,
 * which looks repaired and is arbitrary - the survivor would be whichever one the loop had not
 * reached yet. All or none is the only honest outcome, and the set is a handful of rows.
 */
export async function repairContestedNetWorthLinks(
	prisma: PrismaClient
): Promise<ContestedLinkRepairReport> {
	const rows = await readParticipatingRows(prisma);
	const linesContested = contestedNetWorthLines(rows).length;
	const toClear = accountsToUnlinkForContest(rows);
	if (toClear.length === 0) return { linesContested: 0, cleared: 0 };

	const { count } = await prisma.$transaction(async (tx) =>
		tx.account.updateMany({
			where: { id: { in: toClear }, netWorthAccountId: { not: null } },
			data: { netWorthAccountId: null }
		})
	);
	return { linesContested, cleared: count };
}
