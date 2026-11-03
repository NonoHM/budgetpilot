import { prisma } from '$lib/server/db';
import {
	MAX_PAIRS_PER_REQUEST,
	pairRefusal,
	proposeTransferPairs,
	type PairLeg,
	type PairRefusal,
	type TransferProposals
} from '$lib/domain/transferPair';
import { readIntegerSetting } from '$lib/server/env/readSetting';
import { logReferenceRefused } from '$lib/server/logging/authz';
import { displayAccountName } from '$lib/server/accounts/projection';
import { resolveTransactionType } from './totals';

const ACCOUNT_NAME_SELECT = { name: true, nameKey: true, source: true, institution: true } as const;

/**
 * The only writer of `Transaction.transferPairId` apart from the restore and the three paths that
 * clear it (`replaceSplits`, the start-up account merge, the foreign key's SET NULL). #1189.
 *
 * `not-found` answers a missing id AND another member's id, identically, and writes the same
 * `authz_fail` line for both (AGENTS.md, « Security boundaries »; `logging/authz.ts`).
 */
export type PairResult = { ok: true } | { ok: false; reason: 'not-found' | PairRefusal };

type Tx = Parameters<Parameters<(typeof prisma)['$transaction']>[0]>[0];

const LEG_SELECT = {
	id: true,
	accountId: true,
	date: true,
	amountCents: true,
	type: true,
	currency: true,
	exponent: true,
	transferPairId: true,
	_count: { select: { splits: true } }
} as const;

function toLeg(row: {
	id: string;
	accountId: string;
	date: Date;
	amountCents: number;
	type: string | null;
	currency: string;
	exponent: number;
	transferPairId: string | null;
	_count: { splits: number };
}): PairLeg {
	return {
		id: row.id,
		accountId: row.accountId,
		// The ISO day, the restore's own key rule (backup/import.ts): a restored date may be a full instant.
		date: row.date.toISOString().slice(0, 10),
		amountCents: row.amountCents,
		kind: resolveTransactionType(row),
		currency: row.currency,
		exponent: row.exponent,
		transferPairId: row.transferPairId,
		splitCount: row._count.splits
	};
}

export function transferPairWindowDays(): number {
	return readIntegerSetting('BP_TRANSFER_PAIR_WINDOW_DAYS');
}

class Refused extends Error {
	constructor(readonly reason: 'not-found' | PairRefusal) {
		super(reason);
	}
}

/**
 * Links two legs, or refuses with the reason. Everything is read INSIDE the transaction, after
 * both legs are locked in sorted id order (pass 1189-note-1 N9 and N10): a split committed by
 * `replaceSplits` before the lock is seen by the re-read, one committed after waits on the lock and
 * then clears the link itself, and two confirms sharing a leg serialise instead of deadlocking.
 */
async function linkInside(tx: Tx, userId: string, aId: string, bId: string): Promise<void> {
	for (const id of [aId, bId].sort()) {
		const locked = await tx.transaction.updateMany({
			where: { id, userId },
			data: { updatedAt: new Date() }
		});
		if (locked.count === 0) throw new Refused('not-found');
	}
	const rows = await tx.transaction.findMany({
		where: { userId, id: { in: [aId, bId] } },
		select: LEG_SELECT
	});
	const a = rows.find((row) => row.id === aId);
	const b = rows.find((row) => row.id === bId);
	if (!a || !b) throw new Refused('not-found');
	const refusal = pairRefusal(toLeg(a), toLeg(b));
	if (refusal) throw new Refused(refusal);

	for (const [id, partner] of [
		[aId, bId],
		[bId, aId]
	]) {
		const written = await tx.transaction.updateMany({
			where: { id, userId, transferPairId: null, splits: { none: {} } },
			data: { transferPairId: partner }
		});
		if (written.count !== 1) throw new Refused('already-paired');
	}
}

export async function confirmTransferPair(
	userId: string,
	aId: string,
	bId: string
): Promise<PairResult> {
	if (aId === bId) return { ok: false, reason: 'same-transaction' };
	try {
		await prisma.$transaction((tx) => linkInside(tx, userId, aId, bId));
		return { ok: true };
	} catch (error) {
		if (!(error instanceof Refused)) throw error;
		if (error.reason === 'not-found') logReferenceRefused(userId, 'transaction');
		return { ok: false, reason: error.reason };
	}
}

/**
 * Clears the pair `id`-`partner` AS IT WAS READ, and only while each leg still names the other:
 * between the read and this write another request may unlink the pair and link `partner`
 * elsewhere, and an unguarded clear would then cut that newer pair on one side only (passes
 * 1189-code-1A N6, 1B N13). Returns how many legs it cleared, 0 or 2.
 */
export async function clearReadPair(
	tx: Tx,
	userId: string,
	id: string,
	partner: string
): Promise<number> {
	const cleared = await tx.transaction.updateMany({
		where: {
			userId,
			OR: [
				{ id, transferPairId: partner },
				{ id: partner, transferPairId: id }
			]
		},
		data: { transferPairId: null }
	});
	return cleared.count;
}

/**
 * The « Undo » after a link, and « Unlink »: the PAIRS the page names, in one transaction. A list
 * naming a missing or foreign id unlinks nothing rather than the pairs before it, and each pair is
 * cleared only if it is still the pair stored, so a stale Undo cannot cut a pair it never created
 * (pass 1189-code-2 F2). A pair already undone elsewhere is skipped and not counted.
 */
export async function undoTransferPairs(
	userId: string,
	pairs: readonly (readonly [string, string])[]
): Promise<{ ok: true; unlinked: number } | { ok: false; reason: 'not-found' }> {
	const ids = new Set(pairs.flat());
	try {
		const unlinked = await prisma.$transaction(async (tx) => {
			const owned = await tx.transaction.count({ where: { userId, id: { in: [...ids] } } });
			if (owned !== ids.size) throw new Refused('not-found');
			let cleared = 0;
			for (const [a, b] of pairs) {
				if (await clearReadPair(tx, userId, a, b)) cleared += 1;
			}
			return cleared;
		});
		return { ok: true, unlinked };
	} catch (error) {
		if (!(error instanceof Refused)) throw error;
		logReferenceRefused(userId, 'transaction');
		return { ok: false, reason: 'not-found' };
	}
}

/** Every unpaired, unsplit leg of this member, sorted into proposed, ambiguous and none. */
export async function listTransferProposals(
	userId: string,
	windowDays: number = transferPairWindowDays()
): Promise<TransferProposals> {
	const rows = await prisma.transaction.findMany({
		where: { userId, transferPairId: null, splits: { none: {} } },
		select: LEG_SELECT
	});
	return proposeTransferPairs(rows.map(toLeg), windowDays);
}

export interface ProposedPairView {
	outId: string;
	inId: string;
	fromAccount: string;
	toAccount: string;
	outDate: string;
	inDate: string;
	/** The magnitude, the same on both legs. */
	amountCents: number;
}

/**
 * What the transactions page draws: each proposed pair from its outgoing leg to its incoming one,
 * and how many legs were left out because a match is not unique (the server knows why, so the
 * page says it rather than leaving the reader to wonder, AGENTS.md « Writing a sentence »).
 */
export async function loadTransferProposalView(
	userId: string,
	windowDays: number = transferPairWindowDays()
): Promise<{ pairs: ProposedPairView[]; ambiguousCount: number }> {
	const rows = await prisma.transaction.findMany({
		where: { userId, transferPairId: null, splits: { none: {} } },
		select: { ...LEG_SELECT, account: { select: ACCOUNT_NAME_SELECT } }
	});
	const { proposed, ambiguous } = proposeTransferPairs(rows.map(toLeg), windowDays);
	const byId = new Map(rows.map((row) => [row.id, row]));
	const pairs = proposed.map(([a, b]) => {
		const first = byId.get(a)!;
		const second = byId.get(b)!;
		const [out, into] =
			resolveTransactionType(first) === 'expense' ? [first, second] : [second, first];
		return {
			outId: out.id,
			inId: into.id,
			fromAccount: displayAccountName(out.account),
			toAccount: displayAccountName(into.account),
			outDate: out.date.toISOString().slice(0, 10),
			inDate: into.date.toISOString().slice(0, 10),
			amountCents: Math.abs(out.amountCents)
		};
	});
	return { pairs, ambiguousCount: ambiguous.length };
}

/** The other leg of a paired transaction, as the detail panel names it. */
export async function loadTransferPartner(
	userId: string,
	transferPairId: string | null
): Promise<{ id: string; accountName: string; date: string; amountCents: number } | null> {
	if (!transferPairId) return null;
	const partner = await prisma.transaction.findFirst({
		where: { id: transferPairId, userId },
		select: {
			id: true,
			date: true,
			amountCents: true,
			type: true,
			account: { select: ACCOUNT_NAME_SELECT }
		}
	});
	if (!partner) return null;
	const kind = resolveTransactionType(partner);
	return {
		id: partner.id,
		accountName: displayAccountName(partner.account),
		date: partner.date.toISOString().slice(0, 10),
		amountCents: kind === 'expense' ? -Math.abs(partner.amountCents) : Math.abs(partner.amountCents)
	};
}

/**
 * « Pair all »: the proposals are RECOMPUTED here, never taken from the client, and each pair is
 * confirmed in its own transaction through the same rule as a single click. A pair refused because
 * the data moved since the page was drawn is left as it is and not counted.
 */
export async function pairAllProposed(
	userId: string,
	windowDays: number = transferPairWindowDays(),
	cap: number = MAX_PAIRS_PER_REQUEST
): Promise<{ pairs: [string, string][] }> {
	const { proposed } = await listTransferProposals(userId, windowDays);
	const pairs: [string, string][] = [];
	// At most `cap` per press, so the Undo it offers fits the list the unlink action accepts; the
	// rest stay proposed for the next press (pass 1189-code-2 F1).
	for (const [aId, bId] of proposed.slice(0, cap)) {
		if ((await confirmTransferPair(userId, aId, bId)).ok) pairs.push([aId, bId]);
	}
	return { pairs };
}
