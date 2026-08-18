import * as m from '$lib/paraglide/messages';
import type { TransactionValidationCode } from '$lib/domain/transaction';
import type { CsvRefusalFact, CsvRefusalScope } from '$lib/server/import/refusals';
import { roleLabel } from '$lib/domain/columnMappingLabels';

/**
 * The only place a CSV refusal becomes language.
 *
 * A parser produces a structured fact and never a sentence, so this module is the whole of
 * the other half: every refusal a user reads is rendered here, from the catalogue, in the
 * negotiated locale. It lives in its own module rather than inside `+page.svelte` so that a
 * spec can call it directly, and so the column mapping path can reuse it without rendering a
 * page.
 *
 * None of the three functions below has a `default` arm, and that absence is the enforcement:
 * a code added to either union without a message here fails to compile. The old lookup table
 * this replaces did the opposite, falling back to the raw French string, which is how twelve
 * producers came to have no translation at all and one translation came to match no producer.
 */

/**
 * A domain violation, as produced by `validateTransaction`. Joined by
 * `import_refusal_transaction_invalid` in the order the validator pushed them, which is what
 * makes today's rendered sentence identical to the `errors.join(', ')` it replaces.
 */
export function violationLabel(code: TransactionValidationCode): string {
	switch (code) {
		case 'id-required':
			return m.import_refusal_tx_id_required();
		case 'invalid-iso-date':
			return m.import_refusal_tx_invalid_iso_date();
		case 'amount-cents-required':
			return m.import_refusal_tx_amount_cents_required();
		case 'zero-amount':
			return m.import_refusal_tx_zero_amount();
		case 'amount-too-large':
			return m.import_refusal_tx_amount_too_large();
		case 'invalid-type':
			return m.import_refusal_tx_invalid_type();
		case 'label-required':
			return m.import_refusal_tx_label_required();
		case 'label-too-long':
			return m.import_refusal_tx_label_too_long();
		case 'category-required':
			return m.import_refusal_tx_category_required();
		case 'category-too-long':
			return m.import_refusal_tx_category_too_long();
		case 'invalid-nature':
			return m.import_refusal_tx_invalid_nature();
	}
}

/**
 * What the table's first column shows when a refusal has no line to point at.
 *
 * A header or file scoped refusal is not about any row, so there is no number to print. It
 * renders the scope instead of a blank cell or the placeholder glyph: the scope is more
 * informative than either, and the glyph is an unresolved decision at seven other sites that
 * this deliberately does not add an eighth to. A row scoped refusal never reaches here; the
 * caller prints its real line.
 */
export function scopeLabel(scope: CsvRefusalScope): string {
	switch (scope.kind) {
		case 'file':
			return m.import_invalid_scope_file();
		case 'header':
			return m.import_invalid_scope_header();
		case 'row':
			return String(scope.line);
	}
}

export function refusalLabel(fact: CsvRefusalFact): string {
	switch (fact.code) {
		case 'file-too-large':
			return m.import_refusal_file_too_large({ bytes: fact.bytes });
		case 'file-empty':
			return m.import_refusal_file_empty();
		case 'too-many-rows':
			return m.import_refusal_too_many_rows({ max: fact.max });
		case 'too-many-columns':
			return m.import_refusal_too_many_columns({ max: fact.max });
		case 'header-not-recognized':
			return m.import_refusal_header_not_recognized({ profile: fact.profile });
		case 'unknown-column':
			return m.import_refusal_unknown_column({ column: fact.column });
		case 'duplicate-column':
			return m.import_refusal_duplicate_column({ column: fact.column });
		case 'missing-required-column':
			// Through `roleLabel`, which ALREADY EXISTED: it is the function the designation screen
			// has always used for these four words. A user was reading « Colonne requise absente:
			// date » on a French screen while the screen next door said « Date », one vocabulary in
			// two renderings, and the raw one was ours.
			//
			// Reusing it rather than adding four refusal-specific keys is the whole of the fix. Four
			// new keys would render correctly today and be free to drift tomorrow, because nothing
			// would tie « Montant » in a refusal to « Montant » on the screen the user is being sent
			// back to. One function cannot disagree with itself.
			return m.import_refusal_missing_required_column({ role: roleLabel(fact.role) });
		case 'bad-column-count':
			return m.import_refusal_bad_column_count();
		case 'ambiguous-column-mapping':
			return m.import_refusal_ambiguous_column_mapping({
				role: roleLabel(fact.role),
				columns: fact.columns
			});
		case 'amount-sign-in-separate-column':
			return m.import_refusal_amount_sign_in_separate_column({ column: fact.column });
		case 'amount-split-across-columns':
			return m.import_refusal_amount_split_across_columns({ columns: fact.columns });
		case 'mapping-columns-missing':
			// Joined HERE rather than by the parser. A server side join decides a separator and a
			// language before the catalogue is reached, which is how the role codes travelled into
			// the sentence intact in the first place. A comma rather than a conjunction, because a
			// conjunction is a word and would be the same defect one layer out.
			return m.import_refusal_mapping_columns_missing({
				roles: fact.roles.map(roleLabel).join(', ')
			});
		case 'mapping-invalid':
			// `fact.reason` is deliberately not rendered: the user cannot act on
			// `roles-share-a-column`, and the sentence tells them what they CAN do. The payload
			// stays on the fact for the designation screen to use.
			return m.import_refusal_mapping_invalid();
		case 'invalid-date':
			return m.import_refusal_invalid_date({ value: fact.value });
		case 'invalid-amount':
			return m.import_refusal_invalid_amount();
		case 'zero-amount':
			return m.import_refusal_zero_amount();
		case 'invalid-total-amount':
			return m.import_refusal_invalid_total_amount();
		case 'type-amount-mismatch':
			return m.import_refusal_type_amount_mismatch();
		case 'invalid-nature':
			return m.import_refusal_invalid_nature();
		case 'invalid-fee':
			return m.import_refusal_invalid_fee();
		case 'invalid-balance':
			return m.import_refusal_invalid_balance();
		case 'unsupported-currency':
			return m.import_refusal_unsupported_currency();
		case 'state-not-completed':
			return m.import_refusal_state_not_completed();
		case 'footer-ignored':
			return m.import_refusal_footer_ignored();
		case 'debit-credit-both':
			return m.import_refusal_debit_credit_both();
		case 'debit-credit-empty':
			return m.import_refusal_debit_credit_empty();
		case 'category-too-long':
			return m.import_refusal_category_too_long();
		case 'split-column-unreadable':
			return m.import_refusal_split_column_unreadable();
		case 'split-out-of-bounds':
			return m.import_refusal_split_out_of_bounds();
		case 'split-inconsistent':
			return m.import_refusal_split_inconsistent();
		case 'split-incomplete':
			return m.import_refusal_split_incomplete();
		case 'split-too-many-lines':
			return m.import_refusal_split_too_many_lines();
		case 'split-duplicate-positions':
			return m.import_refusal_split_duplicate_positions();
		case 'split-parent-category-inconsistent':
			return m.import_refusal_split_parent_category_inconsistent();
		case 'split-reserved-category-on-part':
			return m.import_refusal_split_reserved_category_on_part();
		case 'split-sign-opposite':
			return m.import_refusal_split_sign_opposite();
		case 'split-sum-mismatch':
			return m.import_refusal_split_sum_mismatch();
		case 'transaction-invalid':
			return m.import_refusal_transaction_invalid({
				violations: fact.violations.map(violationLabel).join(', ')
			});
	}
}
