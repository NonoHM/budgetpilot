import type { TransactionKind } from './transaction';

/**
 * A transfer between two of a member's own accounts, as two stored rows linked to each other (#1189).
 *
 * `kind` is the row's DIRECTION, resolved by the caller through `resolveTransactionType`
 * (server/transactions/totals.ts), never read from the sign here: `server/import/persist.ts` stores
 * a magnitude and keeps the direction in `type`, so two imported legs are both positive. `date` is
 * the ISO day (`YYYY-MM-DD`), truncated by the caller, because the restore accepts a full instant.
 */
export interface PairLeg {
	id: string;
	accountId: string;
	date: string;
	amountCents: number;
	kind: TransactionKind;
	currency: string;
	exponent: number;
	transferPairId: string | null;
	splitCount: number;
}

export type PairRefusal =
	| 'same-transaction'
	| 'already-paired'
	| 'split'
	| 'same-account'
	| 'same-direction'
	| 'different-currency'
	| 'zero-amount'
	| 'unequal-amount';

/**
 * THE ONE VALIDITY RULE for a pair, consulted by every writer of the link: a single confirm,
 * « Pair all », and the restore. `null` means the two legs may be linked.
 */
export function pairRefusal(a: PairLeg, b: PairLeg): PairRefusal | null {
	if (a.id !== b.id && (a.transferPairId !== null || b.transferPairId !== null)) {
		return 'already-paired';
	}
	return linkRefusal(a, b);
}

/**
 * The part of `pairRefusal` that is about the two legs only, not about their link state. The
 * restore reads a file whose legs already name each other, so it asks this one.
 */
export function linkRefusal(a: PairLeg, b: PairLeg): PairRefusal | null {
	if (a.id === b.id) return 'same-transaction';
	if (a.splitCount > 0 || b.splitCount > 0) return 'split';
	if (a.accountId === b.accountId) return 'same-account';
	if (a.kind === b.kind) return 'same-direction';
	if (a.currency !== b.currency || a.exponent !== b.exponent) return 'different-currency';
	if (a.amountCents === 0 || b.amountCents === 0) return 'zero-amount';
	if (Math.abs(a.amountCents) !== Math.abs(b.amountCents)) return 'unequal-amount';
	return null;
}

export interface TransferProposals {
	/** Each pair as its two ids in sorted order, the pairs sorted. */
	proposed: [string, string][];
	/** Legs with a candidate that were not proposed, because a candidacy is not unique. */
	ambiguous: string[];
	/** Legs with no candidate at all. */
	none: string[];
}

/**
 * How many pairs one request may link (« Link all ») or unlink (« Undo », « Unlink »). The same
 * figure bounds both so a « Link all » press always produces an Undo the unlink action accepts.
 * 250 is `MAX_TRANSACTION_ID_FILTER`'s, the existing cap on ids in one request.
 */
export const MAX_PAIRS_PER_REQUEST = 250;

const DAY_MS = 86_400_000;

function dayNumber(isoDay: string): number {
	return Date.parse(`${isoDay}T00:00:00.000Z`) / DAY_MS;
}

/**
 * Proposes (A, B) only when each is the other's SOLE candidate within `windowDays` days: where the
 * data exhibits two answers it proposes neither and says so (AGENTS.md, « Code style »). Legs
 * already paired or split are neither candidates nor entries. Nothing here writes; a proposal is
 * not an answer (#1205).
 */
export function proposeTransferPairs(
	legs: readonly PairLeg[],
	windowDays: number
): TransferProposals {
	const open = legs.filter((leg) => leg.transferPairId === null && leg.splitCount === 0);
	const byMagnitude = new Map<string, PairLeg[]>();
	for (const leg of open) {
		const key = `${leg.currency}|${leg.exponent}|${Math.abs(leg.amountCents)}`;
		byMagnitude.set(key, [...(byMagnitude.get(key) ?? []), leg]);
	}

	const candidates = new Map<string, string[]>();
	for (const group of byMagnitude.values()) {
		for (const leg of group) {
			candidates.set(
				leg.id,
				group
					.filter(
						(other) =>
							linkRefusal(leg, other) === null &&
							Math.abs(dayNumber(leg.date) - dayNumber(other.date)) <= windowDays
					)
					.map((other) => other.id)
			);
		}
	}

	const proposed: [string, string][] = [];
	const ambiguous: string[] = [];
	const none: string[] = [];
	for (const leg of open) {
		const mine = candidates.get(leg.id) ?? [];
		if (mine.length === 0) {
			none.push(leg.id);
			continue;
		}
		const theirs = mine.length === 1 ? (candidates.get(mine[0]) ?? []) : [];
		if (theirs.length === 1 && theirs[0] === leg.id) {
			if (leg.id < mine[0]) proposed.push([leg.id, mine[0]]);
		} else {
			ambiguous.push(leg.id);
		}
	}

	return {
		proposed: proposed.sort(([a], [b]) => (a < b ? -1 : 1)),
		ambiguous: ambiguous.sort(),
		none: none.sort()
	};
}
