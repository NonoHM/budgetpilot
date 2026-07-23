import { parseMoneyCents } from '$lib/domain/money';

/**
 * Bank statement amount (import profiles: generic, maison, revolut, banque-populaire). Comma or
 * dot decimal, explicit "+" sign accepted (some exports use it), zero valid (a €0 fee/balance
 * line is legitimate), and deliberately NO upper bound — bank statement amounts are trusted as
 * given, unlike a manual/UI entry. Delegates to the shared parseMoneyCents core; see
 * domain/money.ts for the single source of truth.
 */
export function parseAmountCents(value: string): number | null {
	return parseMoneyCents(value, { allowPlusSign: true });
}
