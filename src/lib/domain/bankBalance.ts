/**
 * Pure logic for picking one "authoritative" balance among several `balance_type` entries a
 * bank-sync provider can return for a single account (Enable Banking's
 * GET /accounts/{id}/balances — ISO 20022 BalanceStatus codes, not provider-specific).
 * Infra-agnostic on purpose (no Prisma/connector import) so it's testable without a DB or
 * network, per the project's "financial calculation must be a pure, exported, isolated
 * function" rule.
 */

/** D3 (decided): booked balances first (accounting truth), available/instant as fallback —
 *  a disposal-side balance bakes in overdraft/pending authorizations, which would
 *  misrepresent net worth. CLBD = closing booked, ITBD = interim (intra-day) booked,
 *  XPCD = expected/instantaneous. Unconfirmed beyond the Enable Banking Mock ASPSP sandbox —
 *  see the sandbox validation harness. */
export const BALANCE_TYPE_PREFERENCE = ['CLBD', 'ITBD', 'XPCD'] as const;

export interface BalanceCandidate {
	balanceType: string;
	amountCents: number;
	currency: string;
}

/**
 * Keeps only balances whose currency matches the account's own currency — a foreign-currency
 * sub-balance (e.g. a multi-currency account's USD pocket) must never silently become "the"
 * balance of a EUR-denominated NetWorthAccount.
 */
export function filterBalancesByCurrency<T extends BalanceCandidate>(
	candidates: readonly T[],
	accountCurrency: string
): T[] {
	return candidates.filter((candidate) => candidate.currency === accountCurrency);
}

/**
 * Picks the preferred balance per BALANCE_TYPE_PREFERENCE order; falls back to the first
 * remaining candidate (of any other type) rather than reporting nothing, since a bank
 * exposing only e.g. CLAV/OTHR is still better than no balance at all. Returns null only
 * when there is no candidate left (call filterBalancesByCurrency first).
 */
export function selectPreferredBalance<T extends BalanceCandidate>(
	candidates: readonly T[]
): T | null {
	for (const type of BALANCE_TYPE_PREFERENCE) {
		const match = candidates.find((candidate) => candidate.balanceType === type);
		if (match) return match;
	}
	return candidates[0] ?? null;
}
