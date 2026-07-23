/**
 * Single source of truth for parsing a euro-amount text input into integer cents. Consolidates
 * 3 previously independent, near-duplicate parsers (import bank CSV, manual budget/transaction
 * entry, net worth balance) behind one option-driven core — see money parsers consolidation.
 * Named `parseMoneyCents` (not `parseAmountCents`) to avoid any ambiguity with the pre-existing,
 * now-removed `server/import/utils/money.ts` export of the same short name during/after migration.
 */

export interface ParseMoneyCentsOptions {
	/** Whether "0" is a valid amount. Default true (matches the loosest/original behavior). */
	allowZero?: boolean;
	/** Whether a leading "+" sign is accepted (e.g. "+42.90"). Default false. */
	allowPlusSign?: boolean;
	/** Lower bound (inclusive) on the resulting signed cents value. Undefined = no lower bound. */
	minCents?: number;
	/** Upper bound (inclusive) on the absolute cents value. Undefined = no upper bound. */
	maxAbsCents?: number;
	/**
	 * Enables thousands-separator normalization (e.g. "1.234,56", "1,234.56", "1.234" meaning
	 * one thousand two hundred thirty-four) ahead of the decimal-separator normalization. Default
	 * false: the plain "replace a single comma with a dot" behavior of the original 2 simpler
	 * parsers is preserved unless a caller opts in.
	 */
	allowThousandsSeparator?: boolean;
	/**
	 * Rejects the result if it falls outside Number.isSafeInteger — only the manual-entry and
	 * net-worth parsers checked this historically; the import parser never did (it has no upper
	 * bound at all, by design, for bank statement amounts). Default false to preserve that
	 * distinction; callers that historically checked it must opt in explicitly.
	 */
	requireSafeInteger?: boolean;
}

const PLAIN_AMOUNT_PATTERN = /^[+-]?\d+(\.\d{1,2})?$/;
const NO_PLUS_AMOUNT_PATTERN = /^-?\d+(\.\d{1,2})?$/;

/**
 * Normalizes both European conventions ("1.234,56" dot-thousands/comma-decimal and
 * "1,234.56" comma-thousands/dot-decimal) plus a lone grouping separator with no decimal
 * part ("1.234" or "1,234" meaning one thousand two hundred thirty-four) down to a single
 * '.' decimal separator, e.g. "1234.56". A lone separator followed by exactly 1-2 trailing
 * digits is treated as the decimal point ("12.5", "12,50"); anything else (several
 * separators, or 3+ trailing digits) is treated as thousands grouping and stripped.
 */
function normalizeThousands(trimmed: string): string {
	const hasComma = trimmed.includes(',');
	const hasDot = trimmed.includes('.');

	if (hasComma && hasDot) {
		const decimalIsComma = trimmed.lastIndexOf(',') > trimmed.lastIndexOf('.');
		return decimalIsComma
			? trimmed.replace(/\./g, '').replace(',', '.')
			: trimmed.replace(/,/g, '');
	}
	if (hasComma || hasDot) {
		const separator = hasComma ? ',' : '.';
		const parts = trimmed.split(separator);
		const isDecimal = parts.length === 2 && parts[1].length <= 2;
		return isDecimal ? trimmed.replace(separator, '.') : trimmed.split(separator).join('');
	}
	return trimmed;
}

/**
 * Parses a free-text euro amount (comma or dot decimal separator, optional surrounding/inner
 * whitespace) into integer cents. Returns null on any malformed or out-of-bounds input — never
 * throws. See ParseMoneyCentsOptions for the behavior knobs each caller must set explicitly to
 * reproduce its own historical tolerance (never silently share a default across callers with
 * genuinely different rules).
 */
export function parseMoneyCents(
	value: string,
	options: ParseMoneyCentsOptions = {}
): number | null {
	const {
		allowZero = true,
		allowPlusSign = false,
		minCents,
		maxAbsCents,
		allowThousandsSeparator = false,
		requireSafeInteger = false
	} = options;

	const trimmed = value.trim().replace(/\s/g, '');
	if (!trimmed) return null;

	const normalized = allowThousandsSeparator
		? normalizeThousands(trimmed)
		: trimmed.replace(',', '.');

	const pattern = allowPlusSign ? PLAIN_AMOUNT_PATTERN : NO_PLUS_AMOUNT_PATTERN;
	if (!pattern.test(normalized)) return null;

	const sign = normalized.startsWith('-') ? -1 : 1;
	const unsigned = normalized.replace(/^[+-]/, '');
	const [euros, cents = ''] = unsigned.split('.');
	const amountCents = sign * (Number(euros) * 100 + Number(cents.padEnd(2, '0')));

	if (requireSafeInteger && !Number.isSafeInteger(amountCents)) return null;
	if (!allowZero && amountCents === 0) return null;
	if (minCents !== undefined && amountCents < minCents) return null;
	if (maxAbsCents !== undefined && Math.abs(amountCents) > maxAbsCents) return null;

	return amountCents;
}

/** Manual transaction/budget amount upper bound: 1M€ in cents. */
export const MAX_MANUAL_AMOUNT_CENTS = 100_000_000;

/**
 * Manual transaction amount (dashboard "add transaction" form): comma or dot decimal, no
 * thousands separator, no explicit "+" sign, zero rejected (a transaction always has a
 * direction), bounded to ±1M€. Moved here from `server/budget/dashboard.ts` per the
 * architecture posture (pure logic belongs in domain/, not server/).
 */
export function parseManualAmountCents(value: string): number | null {
	return parseMoneyCents(value, {
		allowZero: false,
		maxAbsCents: MAX_MANUAL_AMOUNT_CENTS,
		requireSafeInteger: true
	});
}
