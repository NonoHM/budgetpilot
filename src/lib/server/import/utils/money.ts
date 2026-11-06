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
 * accepts. Leaves contradictory shapes alone so they stay `null`.
 */
function normalizeImportAmountSign(value: string): string {
	// Match parseMoney's whitespace rule so "( 12,00 )" and "12,00 -" are seen as one token.
	let amount = value.trim().replace(/\s/g, '').replaceAll('\u2212', '-');
	if (!amount) return amount;

	if (amount.startsWith('(') && amount.endsWith(')') && amount.length > 2) {
		const inner = amount.slice(1, -1);
		// A sign already inside the parentheses is not an accounting negative we recognise.
		if (
			inner.startsWith('-') ||
			inner.startsWith('+') ||
			inner.includes('(') ||
			inner.includes(')')
		) {
			return amount;
		}
		amount = `-${inner}`;
	}

	if (amount.endsWith('-') && amount.length > 1) {
		const body = amount.slice(0, -1);
		// Leading and trailing signs together are refused rather than guessed.
		if (body.startsWith('-') || body.startsWith('+')) {
			return amount;
		}
		amount = `-${body}`;
	}

	return amount;
}
