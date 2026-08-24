import { parseMoney } from '$lib/domain/money';

/**
 * Bank statement amount (import profiles: generic, maison, revolut, banque-populaire). Comma or
 * dot decimal, explicit "+" sign accepted (some exports use it), zero valid (a €0 fee/balance
 * line is legitimate), and deliberately NO upper bound — bank statement amounts are trusted as
 * given, unlike a manual/UI entry. The grammar lives in domain/money.ts, which is the only place
 * that knows an amount is scaled by a power of ten.
 */
export function parseAmountCents(value: string): number | null {
	return parseMoney(value, { allowPlusSign: true })?.minorUnits ?? null;
}
