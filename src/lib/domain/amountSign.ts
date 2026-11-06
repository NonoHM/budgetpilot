/**
 * The member's answer when no amount in the file carries a sign (#1207 C2c-S1, decision record
 * #1206 kind 2): every row is money out, or every row is money in. File-wide by construction; a file
 * mixing both with no sign has no answer here (#1284).
 */
export const AMOUNT_SIGNS = ['out', 'in'] as const;

export type AmountSign = (typeof AMOUNT_SIGNS)[number];

/** A posted value outside the closed pair arrives as no answer (ASVS 2.2.1), never as a default. */
export function readAmountSignAnswer(raw: unknown): AmountSign | undefined {
	return AMOUNT_SIGNS.find((sign) => sign === raw);
}
