import { prisma } from '$lib/server/db';
import { isLinkableNetWorthAccountType, type NetWorthAccountType } from '$lib/domain/netWorth';
import { wouldContestNetWorthLine, type NetWorthLinkRow } from '$lib/domain/netWorthLink';
import { normalizeId } from '$lib/server/transactions/where';

/**
 * THE ONLY PLACE `Account.netWorthAccountId` IS SET TO A CHOSEN VALUE.
 *
 * ## What was wrong, and why the repair is a move rather than an addition
 *
 * D4 says at most one SYNCHRONIZED bucket may feed one net worth line. Until #501 it lived inside
 * `linkBankAccountToNetWorth` and the column had two other writers: `linkNetWorthAccount`, reached
 * from /settings, which lists every bank-sync bucket and offers the control on each, and
 * `setManualAccountNetWorthLink`. Both wrote without the check. ONE CONNECTION WAS ENOUGH to reach
 * the bad state, because a bank exposing a current and a savings account gives two synchronized
 * buckets on the first sync, and the user then pointed both at one line in four clicks.
 *
 * Giving the other doors their own copy of the check was the other available shape and it is the
 * one this repository has measured going wrong four times. So the rule moved OUT of every door
 * into `$lib/domain/netWorthLink`, and the three doors moved IN here. What each door keeps is what
 * is genuinely its own: which buckets it may address, and how a refusal is reported to its layer.
 *
 * ## Why not the database, which would be stronger still
 *
 * The constraint is `unique(userId, netWorthAccountId) WHERE bankConnectionId IS NOT NULL`.
 * PostgreSQL and SQLite have partial unique indexes; MySQL/MariaDB does not; and Prisma has no
 * `where` on `@@unique` on any engine, so it would be three hand-written migrations of which one
 * could not express the rule at all. A constraint that holds on two engines out of three is worse
 * than none, because it makes a rule about money depend on the operator's choice of database. The
 * portable alternative is a shadow column every writer has to maintain, which is this same
 * duplication one layer down with a migration attached. Both were considered and rejected for those
 * reasons rather than for size.
 *
 * ## Why the read and the write share a transaction
 *
 * Without it two concurrent requests linking different buckets to one target both pass the conflict
 * read before either writes, and D4 falls to timing rather than to a missing check. ASVS 5.0.0
 * `v5.0.0-2.3.4`, business-logic locking against double-booking a limited-quantity resource: a net
 * worth line holds exactly one authoritative synchronized balance writer, which is a quantity of
 * one. `linkBankAccountToNetWorth` already ran inside a transaction for this reason; /settings' door
 * did not, because it had no read to pair a write with.
 */

/**
 * Why a link was refused. A VALUE rather than a thrown framework error, because the doors report to
 * different layers: one renders a SvelteKit `error()` and the other an `AccountWriteError` that
 * /settings maps to a sentence. A refusal recognised by matching its text would make each caller
 * share a source with the thrower, which is the shape that asserts nothing.
 */
export type NetWorthLinkRefusal = 'account-not-found' | 'net-worth-not-found' | 'already-synced';

export interface NetWorthLinkInput {
	userId: string;
	/** The bucket whose link is being written. A CLAIM from a request, authorised here. */
	accountId: string;
	/** The line it should feed, or null to clear. Also a claim, also authorised here. */
	netWorthAccountId: string | null;
	/**
	 * Which buckets this door may address. `bank-sync` is /imports/bank-connections, whose subject
	 * is a connection's buckets and which answers not-found for anything else; `any` is /settings
	 * and /net-worth, which address a bucket the user picked from a list. A NARROWING of the
	 * lookup, never a second rule: what follows is identical either way.
	 */
	bucket: 'bank-sync' | 'any';
}

/** Sets, or clears, the net worth line one bucket feeds. Returns null when the write happened. */
export async function writeNetWorthLink(
	input: NetWorthLinkInput
): Promise<NetWorthLinkRefusal | null> {
	const accountId = normalizeId(input.accountId);
	if (!accountId) return 'account-not-found';

	return prisma.$transaction(async (tx) => {
		// FIRST OBJECT REFERENCE. `userId` is in the same where clause rather than checked after the
		// row comes back, so a bucket belonging to somebody else is indistinguishable from one that
		// never existed and the response is not an oracle for whether another user's id is real.
		const bucket = await tx.account.findFirst({
			where: {
				id: accountId,
				userId: input.userId,
				...(input.bucket === 'bank-sync' ? { bankConnectionId: { not: null } } : {})
			},
			select: { id: true, bankConnectionId: true }
		});
		if (!bucket) return 'account-not-found';

		if (input.netWorthAccountId !== null) {
			// SECOND OBJECT REFERENCE, and it is a separate authorisation: a function validating one of
			// them looks exactly like a function validating both. One reason covers absent, foreign and
			// not-linkable, for the same non-oracle reason as above. The type is validated by CALLING
			// the domain predicate rather than by retyping its list - ASVS 5.0.0 `v5.0.0-2.2.1`,
			// positive validation against an allow list, for input that makes a business decision. A
			// house is not a cash line, and filing a statement's transactions against one would put
			// spending into an asset's balance.
			const target = await tx.netWorthAccount.findFirst({
				where: { id: input.netWorthAccountId, userId: input.userId, deletedAt: null },
				select: { id: true, type: true }
			});
			if (!target || !isLinkableNetWorthAccountType(target.type as NetWorthAccountType)) {
				return 'net-worth-not-found';
			}

			// EVERY row pointing at this line, and the absence of a `userId` clause here is deliberate
			// and is the one place in this function without one.
			//
			// The two reads above AUTHORISE, so they are scoped by the caller. This one COUNTS: it asks
			// how many buckets feed a line the caller has already been shown to own, and scoping it by
			// `userId` would make the answer wrong rather than safe. A row of another tenant pointing
			// at this line is a corruption no path should produce, and if one exists it is writing
			// balances into this line today; the honest answer is to refuse the write rather than to
			// filter the evidence out of the count and double the damage. It leaks nothing, because
			// what comes back is one boolean about the caller's own line.
			//
			// Unbounded on purpose. A `take` would silently turn a long list into a short one, and the
			// direction it fails in is the comfortable one: fewer rows read means fewer conflicts
			// found. The set is every bucket feeding ONE line, which is a handful.
			const feeding = await tx.account.findMany({
				where: { netWorthAccountId: input.netWorthAccountId },
				select: { id: true, bankConnectionId: true }
			});

			const rows: NetWorthLinkRow[] = feeding.map((row) => ({
				accountId: row.id,
				netWorthAccountId: input.netWorthAccountId,
				synchronized: row.bankConnectionId !== null
			}));
			const candidate: NetWorthLinkRow = {
				accountId: bucket.id,
				netWorthAccountId: input.netWorthAccountId,
				synchronized: bucket.bankConnectionId !== null
			};

			if (wouldContestNetWorthLine(rows, candidate)) return 'already-synced';
		}

		await tx.account.updateMany({
			where: { id: bucket.id, userId: input.userId },
			data: { netWorthAccountId: input.netWorthAccountId }
		});
		return null;
	});
}
