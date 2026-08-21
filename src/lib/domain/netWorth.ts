export const NET_WORTH_ACCOUNT_TYPES = [
	'checking',
	'savings',
	'investment',
	'real_estate',
	'other',
	'debt'
] as const;
export type NetWorthAccountType = (typeof NET_WORTH_ACCOUNT_TYPES)[number];

export function isNetWorthAccountType(value: string): value is NetWorthAccountType {
	return (NET_WORTH_ACCOUNT_TYPES as readonly string[]).includes(value);
}

/**
 * Types that can plausibly hold real transactions and therefore be linked to a technical
 * `Account` bucket (manual entry or CSV import) via `Account.netWorthAccountId`. Excludes
 * `real_estate` and `other`, which stay purely declarative — linking a house to an import
 * bucket has no meaning.
 */
export const LINKABLE_NET_WORTH_ACCOUNT_TYPES = [
	'checking',
	'savings',
	'investment',
	'debt'
] as const;
export type LinkableNetWorthAccountType = (typeof LINKABLE_NET_WORTH_ACCOUNT_TYPES)[number];

export function isLinkableNetWorthAccountType(
	type: NetWorthAccountType
): type is LinkableNetWorthAccountType {
	return (LINKABLE_NET_WORTH_ACCOUNT_TYPES as readonly string[]).includes(type);
}

/**
 * Pre-selects a NetWorthAccountType for the bank-sync explicit-link form from the provider's
 * cash_account_type (Enable Banking's ISO 20022-derived CashAccountType — CACC/SVGS/CARD/
 * LOAN/CASH/OTHR, persisted verbatim on Account.providerCashAccountType). Deliberately never
 * authoritative: this only pre-fills the form the user confirms/overrides when explicitly
 * linking a bucket (see CLAUDE.md's "lien toujours explicite" convention) — the caller must
 * never use this to auto-link.
 *
 * CACC/SVGS map directly. LOAN maps to `debt` (sign convention assumed, not yet confirmed
 * against a real ASPSP loan account — treat as a form default only). CARD is ambiguous
 * between a debit card (checking) and a credit card (debt): `hasCreditLimit` breaks the tie
 * when the caller has it (from a live provider account fetch — not persisted on Account, so
 * pass `false`/unknown when only the stored `providerCashAccountType` is available, which
 * conservatively suggests `checking`). CASH/OTHR/unrecognized codes return no suggestion.
 */
export function suggestNetWorthAccountType(
	cashAccountType: string | null,
	hasCreditLimit: boolean
): LinkableNetWorthAccountType | null {
	switch (cashAccountType) {
		case 'CACC':
			return 'checking';
		case 'SVGS':
			return 'savings';
		case 'LOAN':
			return 'debt';
		case 'CARD':
			return hasCreditLimit ? 'debt' : 'checking';
		default:
			return null;
	}
}

import { parseMoney } from './money';

// 10M€, raised from the original 1M€ cap: too low for a real estate or a sizable
// investment/debt account (see net-worth audit finding #6).
const MAX_NET_WORTH_BALANCE_CENTS = 1_000_000_000;

/**
 * Unlike parseManualAmountCents (transaction amounts), 0 is a valid value here — a fresh,
 * empty account is a legitimate declared balance. Supports both European thousands-separator
 * conventions (see parseMoney's allowThousandsSeparator doc). The grammar itself lives in
 * domain/money.ts, which is the only place that knows an amount is scaled by a power of ten.
 */
export function parseNetWorthBalanceCents(value: string): number | null {
	return (
		parseMoney(value, {
			allowThousandsSeparator: true,
			maxAbsMinorUnits: MAX_NET_WORTH_BALANCE_CENTS,
			requireSafeInteger: true
		})?.minorUnits ?? null
	);
}

export interface NetWorthAccountBalance {
	type: NetWorthAccountType;
	balanceCents: number;
}

/** A debt reduces net worth; other account types increase it. */
export function signedNetWorthCents(type: NetWorthAccountType, balanceCents: number): number {
	return type === 'debt' ? -balanceCents : balanceCents;
}

export function computeNetWorthTotal(accounts: readonly NetWorthAccountBalance[]): number {
	return accounts.reduce(
		(total, account) => total + signedNetWorthCents(account.type, account.balanceCents),
		0
	);
}

export const ASSET_NET_WORTH_ACCOUNT_TYPES = [
	'checking',
	'savings',
	'investment',
	'real_estate',
	'other'
] as const;
export type AssetNetWorthAccountType = (typeof ASSET_NET_WORTH_ACCOUNT_TYPES)[number];

export interface NetWorthAssetBreakdownEntry {
	type: AssetNetWorthAccountType;
	totalCents: number;
	pct: number;
}

/**
 * Sums each account's signed contribution to net worth (see signedNetWorthCents) PER TYPE —
 * shared between buildNetWorthAssetBreakdown() and computeNegativeBalanceTotal() so both always
 * agree on what a "type" is worth overall. Grouping matters: two checking accounts, +1200€ and
 * -300€, must be judged on their combined 900€ (an asset, shown in the donut), not have the
 * -300€ side counted separately as if it were its own negative line — that would double-count
 * the same 300€ once inside the donut's netted total and once again in the negative-balance line.
 */
function groupSignedTotalsByType(
	accounts: readonly NetWorthAccountBalance[]
): Map<NetWorthAccountType, number> {
	const totalsByType = new Map<NetWorthAccountType, number>();
	for (const account of accounts) {
		const signed = signedNetWorthCents(account.type, account.balanceCents);
		totalsByType.set(account.type, (totalsByType.get(account.type) ?? 0) + signed);
	}
	return totalsByType;
}

/**
 * Assets grouped by type (checking/savings/investment), debt deliberately excluded — debt is
 * shown separately as it already reduces the net worth total rather than being "an asset slice".
 * Types with a zero or negative total are omitted (nothing to represent as a donut slice).
 *
 * The percentage base is the sum of the POSITIVE type totals only, never the raw sum across
 * all asset types: an overdrawn checking account (a negative balance is a valid, allowed value —
 * see parseNetWorthBalanceCents) must never zero out or skew the breakdown of genuinely positive
 * savings/investment balances just because it drags the raw sum below zero.
 */
export function buildNetWorthAssetBreakdown(
	accounts: readonly NetWorthAccountBalance[]
): NetWorthAssetBreakdownEntry[] {
	const totalsByType = groupSignedTotalsByType(accounts);

	const positiveTotal = ASSET_NET_WORTH_ACCOUNT_TYPES.map((type) => totalsByType.get(type) ?? 0)
		.filter((cents) => cents > 0)
		.reduce((sum, cents) => sum + cents, 0);
	if (positiveTotal <= 0) return [];

	return ASSET_NET_WORTH_ACCOUNT_TYPES.filter((type) => (totalsByType.get(type) ?? 0) > 0).map(
		(type) => {
			const totalCents = totalsByType.get(type) ?? 0;
			return { type, totalCents, pct: (totalCents / positiveTotal) * 100 };
		}
	);
}

/**
 * Every type whose overall balance is non-positive — every declared debt (always ≤ 0 once
 * signed), plus any non-debt type whose accounts net out at or below zero (an overdrawn checking
 * account, a brokerage type down -5000€ overall, etc.). A negative balance drags down net worth
 * exactly like a debt does regardless of the account's declared type, and
 * buildNetWorthAssetBreakdown() deliberately excludes non-positive type totals from the donut, so
 * this is the only other place that money can surface. Together, this total and the donut's
 * positive-type totals are exhaustive: they always sum to computeNetWorthTotal() (see the
 * regression test asserting this invariant) — because both are just a partition, by sign, of the
 * exact same per-type totals.
 */
export function computeNegativeBalanceTotal(accounts: readonly NetWorthAccountBalance[]): number {
	const totalsByType = groupSignedTotalsByType(accounts);
	return [...totalsByType.values()]
		.filter((cents) => cents <= 0)
		.reduce((sum, cents) => sum + cents, 0);
}

/**
 * Guards against JS's negative-zero formatting quirk: `formatCents(-0)` renders "-0,00 €" (a
 * real Intl.NumberFormat behavior), which reads as if a negative balance existed but wasn't
 * counted. A zero total must display as a plain "0,00 €".
 */
export function negativeBalanceDisplayCents(negativeBalanceTotalCents: number): number {
	return negativeBalanceTotalCents === 0 ? 0 : negativeBalanceTotalCents;
}

export interface NetWorthSnapshotPoint {
	accountId: string;
	/**
	 * Frozen at capture time (see the NetWorthSnapshot.type doc comment in schema.prisma):
	 * this timeline must never re-derive a point's sign from the account's CURRENT type,
	 * or a later type change (e.g. savings -> debt) would retroactively flip the sign of
	 * every past point on the curve.
	 */
	type: NetWorthAccountType;
	balanceCents: number;
	capturedAt: Date;
}

export interface NetWorthTimelinePoint {
	capturedAt: string;
	totalCents: number;
}

/**
 * Timeline of total net worth, one point per distinct snapshot timestamp (no monthly
 * grouping — manual entries are rare and deliberate, unlike bank-synced apps that
 * group by month to filter daily sync noise). At each timestamp, the total is still
 * aggregated PER ACCOUNT: the latest known snapshot of EACH account as of that instant
 * (or before), summed — never the latest snapshot across all rows, which would give a
 * wrong total as soon as accounts are updated at different times.
 * An account with no snapshot yet at a given timestamp is simply excluded from that
 * point's total. Every snapshot carries its own type, so a soft-deleted account's PAST
 * snapshots keep contributing their historically-correct sign to the points before it
 * was closed.
 *
 * `deletedAtByAccount` is what stops that carrying-forward from running past the closure,
 * and it is required rather than optional on purpose. Without it an account's last known
 * balance was carried forward at EVERY later timestamp, including the rightmost one — so a
 * closed account went on contributing to « today » forever and the curve's present point
 * overstated by whatever the user had removed. Measured on the real screen: headline
 * 2 400,00 € above a curve reading 10 900,00 €, same card, same render.
 *
 * A deletion is also a POINT, not only a cutoff. Soft-deleting writes no snapshot, so
 * without its own timestamp the change would not appear on the curve at all until the next
 * unrelated edit — the total would step down retroactively at whatever moment came next,
 * which is a different (and later) date than the one the user acted on.
 *
 * Deliberately NOT solved by writing a zero-balance closing snapshot: that would record a
 * balance the account never had, and it would be indistinguishable afterwards from an
 * account the user really did empty.
 */
export function buildNetWorthTimeline(
	snapshots: readonly NetWorthSnapshotPoint[],
	deletedAtByAccount: ReadonlyMap<string, Date>
): NetWorthTimelinePoint[] {
	if (snapshots.length === 0) return [];

	const snapshotsByAccount = new Map<string, NetWorthSnapshotPoint[]>();
	for (const snapshot of snapshots) {
		const list = snapshotsByAccount.get(snapshot.accountId) ?? [];
		list.push(snapshot);
		snapshotsByAccount.set(snapshot.accountId, list);
	}
	for (const list of snapshotsByAccount.values()) {
		list.sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
	}

	const deletionTimes = new Map<string, number>();
	for (const [accountId, deletedAt] of deletedAtByAccount) {
		deletionTimes.set(accountId, deletedAt.getTime());
	}

	const timestamps = [
		...new Set([
			...snapshots.map((s) => s.capturedAt.getTime()),
			// Only closures of accounts this series actually knows about: a deletion with no snapshot
			// behind it would add a point at which nothing changed.
			...[...deletionTimes.entries()]
				.filter(([accountId]) => snapshotsByAccount.has(accountId))
				.map(([, time]) => time)
		])
	].sort((a, b) => a - b);

	return timestamps.map((ts) => {
		let totalCents = 0;
		for (const [accountId, list] of snapshotsByAccount) {
			// `<=`, so the deletion's own point already shows the total WITHOUT the closed account —
			// that point exists to say what changed, and it would say nothing if it still counted it.
			const deletedAt = deletionTimes.get(accountId);
			if (deletedAt !== undefined && deletedAt <= ts) continue;

			let lastKnown: NetWorthSnapshotPoint | undefined;
			for (const point of list) {
				if (point.capturedAt.getTime() > ts) break;
				lastKnown = point;
			}
			if (lastKnown) totalCents += signedNetWorthCents(lastKnown.type, lastKnown.balanceCents);
		}
		return { capturedAt: new Date(ts).toISOString(), totalCents };
	});
}
