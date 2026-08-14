import type { TransactionValidationCode } from '$lib/domain/transaction';

/**
 * Where a refusal applies. A header level complaint has nowhere to put a line number,
 * which is how #291 is made unrepresentable rather than corrected: the invented
 * `index + 1` that used to be presented as a file line cannot be written back.
 */
export type CsvRefusalScope = { kind: 'file' } | { kind: 'header' } | { kind: 'row'; line: number };

/**
 * A refusal as a structured fact. A parser produces one of these and never a sentence:
 * the UI is the only place language exists.
 *
 * There is deliberately no free text member. That absence IS the enforcement, and a
 * grep based gate over the profiles was considered and refused: a scan for French
 * literals matches legitimate strings on a clean tree, and a gate that is wrong on a
 * clean tree gets deleted by the first person who meets it, taking the working half
 * with it. Adding a `{ message: string }` member here is a visible type change.
 *
 * Several members carry a value that the message rendered by this PR does not display:
 * `invalid-date`, `invalid-amount`, `zero-amount` and `invalid-total-amount` carry `column`;
 * `invalid-nature` carries `value`; `unsupported-currency` carries `currency`;
 * `state-not-completed` carries `state`; `bad-column-count` carries `expected` and `actual`.
 * That is deliberate, not an oversight: PR1's whole constraint is that no user-visible
 * string changes, and today's sentences simply do not contain those values. The fact still
 * carries the data because a later consumer needs it (the column-mapping path, and the
 * field-highlight mechanism on `CsvRefusal`), while the message goes on rendering today's
 * wording unchanged. Do not delete an unrendered payload as dead: turning one into visible
 * text is a copy change for that later task to make, not a cleanup of this one.
 *
 * Only three members render their payload today, and they are the exception rather than the
 * rule: `unknown-column`, `duplicate-column` and `missing-required-column`, each through the
 * catalogue's `{column}` placeholder, because those three are the only ones whose existing
 * sentence already names the value.
 */
export type CsvRefusalFact =
	// file level, always { kind: 'file' } scope except header-not-recognized, which is
	// { kind: 'header' }: none of the four has a line to point at.
	| { code: 'file-too-large'; bytes: number }
	| { code: 'file-empty' }
	| { code: 'too-many-rows'; max: number }
	| { code: 'too-many-columns'; max: number }
	| { code: 'header-not-recognized'; profile: string }
	// structural
	| { code: 'unknown-column'; column: string }
	| { code: 'duplicate-column'; column: string }
	| { code: 'missing-required-column'; column: string }
	| { code: 'bad-column-count'; expected: number; actual: number }
	// Two distinct headers claiming the same required role. Carries BOTH, because naming
	// only one would tell the user to look at half the problem. See columnAliases.ts for why
	// this refuses rather than picking.
	| { code: 'ambiguous-column-mapping'; role: string; columns: string }
	// The amount column holds magnitudes and a sibling column holds the direction, so every
	// row would import as income. Carries the offending column so the user can look at it: a
	// refusal saying "your amounts have no sign" leaves them nowhere to go.
	| { code: 'amount-sign-in-separate-column'; column: string }
	// row level
	| { code: 'invalid-date'; column: string }
	| { code: 'invalid-amount'; column: string }
	| { code: 'zero-amount'; column: string }
	| { code: 'invalid-total-amount'; column: string }
	| { code: 'type-amount-mismatch' }
	| { code: 'invalid-nature'; value: string }
	| { code: 'invalid-fee' }
	| { code: 'invalid-balance' }
	| { code: 'unsupported-currency'; currency: string }
	| { code: 'state-not-completed'; state: string }
	| { code: 'footer-ignored' }
	| { code: 'debit-credit-both' }
	| { code: 'debit-credit-empty' }
	| { code: 'category-too-long' }
	// repartition, maison v2 only
	| { code: 'split-column-unreadable' }
	| { code: 'split-out-of-bounds' }
	| { code: 'split-inconsistent' }
	| { code: 'split-incomplete' }
	| { code: 'split-too-many-lines' }
	| { code: 'split-duplicate-positions' }
	| { code: 'split-parent-category-inconsistent' }
	| { code: 'split-reserved-category-on-part' }
	| { code: 'split-sign-opposite' }
	| { code: 'split-sum-mismatch' }
	// The domain's own verdict, carried as codes rather than as the sentences
	// `validateTransaction` used to return. Rendered by the catalogue's
	// `import_refusal_transaction_invalid` key, whose `{violations}` placeholder is filled
	// with the joined per-code labels, in the same source order `validateTransaction` pushed
	// them, with no prefix: today the user sees exactly `validation.errors.join(', ')`.
	| { code: 'transaction-invalid'; violations: TransactionValidationCode[] };

export type CsvRefusalCode = CsvRefusalFact['code'];

export interface CsvRefusal {
	scope: CsvRefusalScope;
	fact: CsvRefusalFact;
	/**
	 * Which form field to highlight. Unchanged meaning: it names a field, and never
	 * carries data lifted from the file. Column names and cell values live in the fact,
	 * which is the half the catalogue renders.
	 */
	field?: string;
}

export const CSV_REFUSAL_CODES = [
	'file-too-large',
	'file-empty',
	'too-many-rows',
	'too-many-columns',
	'header-not-recognized',
	'unknown-column',
	'duplicate-column',
	'missing-required-column',
	'bad-column-count',
	'ambiguous-column-mapping',
	'amount-sign-in-separate-column',
	'invalid-date',
	'invalid-amount',
	'zero-amount',
	'invalid-total-amount',
	'type-amount-mismatch',
	'invalid-nature',
	'invalid-fee',
	'invalid-balance',
	'unsupported-currency',
	'state-not-completed',
	'footer-ignored',
	'debit-credit-both',
	'debit-credit-empty',
	'category-too-long',
	'split-column-unreadable',
	'split-out-of-bounds',
	'split-inconsistent',
	'split-incomplete',
	'split-too-many-lines',
	'split-duplicate-positions',
	'split-parent-category-inconsistent',
	'split-reserved-category-on-part',
	'split-sign-opposite',
	'split-sum-mismatch',
	'transaction-invalid'
] as const satisfies readonly CsvRefusalCode[];

// Exhaustive in the other direction too: a code in the union but absent from the array
// makes this line fail to compile, so the runtime list cannot silently fall behind.
type MissingFromArray = Exclude<CsvRefusalCode, (typeof CSV_REFUSAL_CODES)[number]>;
const _everyCodeIsListed: MissingFromArray extends never ? true : never = true;
void _everyCodeIsListed;
