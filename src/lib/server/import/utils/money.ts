import { parseMoney } from '$lib/domain/money';

/**
 * Bank statement amount (import profiles: generic, maison, revolut, banque-populaire). Comma or
 * dot decimal, explicit "+" sign accepted (some exports use it), zero valid (a €0 fee/balance
 * line is legitimate), and deliberately NO upper bound — bank statement amounts are trusted as
 * given, unlike a manual/UI entry. The grammar lives in domain/money.ts, which is the only place
 * that knows an amount is scaled by a power of ten.
 *
 * Before that grammar runs, this door rewrites three bank-export negative shapes that `parseMoney`
 * does not accept on its own (#1285): a Unicode minus (U+2212), accounting parentheses, and a
 * trailing ASCII or Unicode minus. Manual entry keeps the stricter door and is unchanged.
 */
export function parseAmountCents(value: string): number | null {
	return parseMoney(normalizeImportAmountSign(value), { allowPlusSign: true })?.minorUnits ?? null;
}

/**
 * Maps bank-statement negative notations onto a leading ASCII hyphen that `parseMoney` already
 * accepts. Contradictory shapes become doubled or mixed signs that `parseMoney` refuses.
 */
function normalizeImportAmountSign(value: string): string {
	// Match parseMoney's whitespace rule so "( 12,00 )" and "12,00 -" are seen as one token.
	let amount = value.trim().replace(/\s/g, '').replaceAll('\u2212', '-');
	if (!amount) return amount;

	if (amount.startsWith('(') && amount.endsWith(')') && amount.length > 2) {
		amount = `-${amount.slice(1, -1)}`;
	}

	if (amount.endsWith('-') && amount.length > 1) {
		amount = `-${amount.slice(0, -1)}`;
	}

	return amount;
}
