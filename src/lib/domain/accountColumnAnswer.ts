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
 * resolved against the tracked source (`docs/reference/standards/asvs-5.0.0/`, #601) and quoted
 * inline: « Verify that input is validated to enforce business or functional
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

/**
 * AN ANSWER IS ABOUT ONE COLUMN, never about the file (#1255). A file can carry two unproven
 * account columns; « not an account » about the first said nothing about the second, and read
 * file-wide it filed both accounts' rows under one. Firefly III's importer binds a role to a
 * column index the same way (`docs/superpowers/2026-11-04-1255-column-answer-research.md`).
 */
export interface AccountColumnAnswerFor {
	column: number;
	answer: AccountColumnAnswer;
}

/** The posted form of one answer, `<answer>:<column index>`, the only form `read...` accepts. */
export function writeAccountColumnAnswer({ column, answer }: AccountColumnAnswerFor): string {
	return `${answer}:${column}`;
}

/** A canonical decimal index: no sign, no leading zero, no fraction, four digits at most. */
const COLUMN_INDEX = /^(0|[1-9]\d{0,3})$/;

/**
 * Every posted answer, validated positively (ASVS v5.0.0-2.2.1): a closed-set answer and a
 * canonical column index below `columnLimit`. An answer naming no column is no answer, so the door
 * asks again rather than reading it file-wide. Two answers that disagree about one column are both
 * dropped (ASVS v5.0.0-2.2.3, a combination that is not reasonable): the question is asked again,
 * never settled by whichever came first.
 *
 * @param raw `FormData.getAll`, so a `File` entry from a hand-made request is possible.
 * @param columnLimit The widest file the parser accepts; no column at or past it exists.
 */
export function readAccountColumnAnswers(
	raw: readonly unknown[],
	columnLimit: number
): AccountColumnAnswerFor[] {
	const byColumn = new Map<number, AccountColumnAnswer | 'disagree'>();
	for (const value of raw) {
		if (typeof value !== 'string') continue;
		const parts = value.split(':');
		// Exactly `<answer>:<index>`: a value naming no column is no answer, never a file-wide one.
		if (parts.length !== 2) continue;
		const [posted, index] = parts;
		// The closed set is `readAccountColumnAnswer`'s, called rather than respelled.
		const answer = readAccountColumnAnswer(posted);
		if (answer === undefined || !COLUMN_INDEX.test(index)) continue;
		const column = Number(index);
		if (column >= columnLimit) continue;
		const held = byColumn.get(column);
		byColumn.set(column, held === undefined || held === answer ? answer : 'disagree');
	}
	return [...byColumn]
		.filter((entry): entry is [number, AccountColumnAnswer] => entry[1] !== 'disagree')
		.map(([column, answer]) => ({ column, answer }));
}
