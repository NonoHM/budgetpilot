import { prisma } from '$lib/server/db';
import {
	pairRefusal,
	proposeTransferPairs,
	type PairLeg,
	type PairRefusal,
	type TransferProposals
} from '$lib/domain/transferPair';
import { readIntegerSetting } from '$lib/server/env/readSetting';
import { logReferenceRefused } from '$lib/server/logging/authz';
import { resolveTransactionType } from './totals';

/**
 * The only writer of `Transaction.transferPairId` apart from the restore and the three paths that
 * clear it (`replaceSplits`, the start-up account merge, the foreign key's SET NULL). #1189.
 *
 * `not-found` answers a missing id AND another member's id, identically, and writes the same
 * `authz_fail` line for both (AGENTS.md, « Security boundaries »; `logging/authz.ts`).
 */
export type PairResult = { ok: true } | { ok: false; reason: 'not-found' | PairRefusal };
export type UndoResult = { ok: true } | { ok: false; reason: 'not-found' | 'not-paired' };

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

/** Clears the link on both legs, from either side. */
export async function undoTransferPair(userId: string, id: string): Promise<UndoResult> {
	return prisma.$transaction(async (tx) => {
		const leg = await tx.transaction.findFirst({
			where: { id, userId },
			select: { transferPairId: true }
		});
		if (!leg) {
			logReferenceRefused(userId, 'transaction');
			return { ok: false, reason: 'not-found' } as const;
		}
		if (leg.transferPairId === null) return { ok: false, reason: 'not-paired' } as const;
		await tx.transaction.updateMany({
			where: { userId, id: { in: [id, leg.transferPairId] } },
			data: { transferPairId: null }
		});
		return { ok: true } as const;
	});
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

/**
 * « Pair all »: the proposals are RECOMPUTED here, never taken from the client, and each pair is
 * confirmed in its own transaction through the same rule as a single click. A pair refused because
 * the data moved since the page was drawn is left as it is and not counted.
 */
export async function pairAllProposed(
	userId: string,
	windowDays: number = transferPairWindowDays()
): Promise<{ paired: number }> {
	const { proposed } = await listTransferProposals(userId, windowDays);
	let paired = 0;
	for (const [aId, bId] of proposed) {
		if ((await confirmTransferPair(userId, aId, bId)).ok) paired += 1;
	}
	return { paired };
}
