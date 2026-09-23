/**
 * Whether a column `discriminant.ts` could only call `basis: 'digit-run'` — exhibiting ambiguity,
 * proving nothing — actually names accounts.
 *
 * ## Why this lives in `domain/` rather than beside `discriminant.ts`
 *
 * Exactly `dateReading.ts`'s reason: the answer is POSTED from a browser component (the dialog
 * that asks the question), and `$lib/server` is not importable from the client bundle. A value
 * import from `server/import/discriminant.ts` here would pull server code across that line.
 *
 * ## The two answers, and why `'is-account'` promotes rather than splits
 *
 * `'is-account'` means the user has just PROVEN what the grammar alone could not: the column
 * refuses exactly like a verified IBAN pair does, never attempting to write each value to its own
 * account. `'not-account'` means the column is noise (a reference number, a running balance) and
 * the parse proceeds as if `discriminant.ts` had answered `none`. See #485.
 */
export const ACCOUNT_COLUMN_ANSWERS = ['is-account', 'not-account'] as const;

export type AccountColumnAnswer = (typeof ACCOUNT_COLUMN_ANSWERS)[number];

/**
 * A POSTED answer, validated into one, or `undefined` when the request carried no usable value.
 *
 * `undefined` rather than a refusal or a repaired guess, same as `readDateOrderAnswer`: an absent,
 * empty or hostile value falls back to the door asking again rather than being interpreted as
 * either answer. ASVS 5.0 **V2.2.1** (L1, Validation and Business Logic > Input Validation),
 * resolved against the local source (`scripts/security/asvs-5.0-source/`, gitignored per #601)
 * and quoted inline: « Verify that input is validated to enforce business or functional
 * expectations for that input. This should either use positive validation against an allow list
 * of values, patterns, and ranges, or be based on comparing the input to an expected structure
 * and logical limits according to predefined rules. »
 *
 * @param raw Whatever the request carried. `FormData.get` returns `string | File | null`, and the
 *   `File` branch is reachable from a hand-made multipart request, so the type here is `unknown`.
 */
export function readAccountColumnAnswer(raw: unknown): AccountColumnAnswer | undefined {
	return ACCOUNT_COLUMN_ANSWERS.find((answer) => answer === raw);
}
