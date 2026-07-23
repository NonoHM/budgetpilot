/**
 * "To classify" category: system fallback, never deletable or renamable.
 * Technical slug stored in DB — never displayed as-is, never translated as
 * plain text: resolution to a label happens only at display time via
 * `categoryLabel()` (Paraglide key `common_category_uncategorized`).
 */
export const UNCLASSIFIED_CATEGORY = 'uncategorized';

/**
 * Category pre-filled for an editable "Proposal" block (TransactionProposalCard): the
 * rule suggestion if there is one, otherwise UNCLASSIFIED_CATEGORY — never an empty/broken
 * field when no rule matches (existing default behavior, see CLAUDE.md).
 */
export function resolveProposalCategory(suggestion: { category: string } | null): string {
	return suggestion?.category ?? UNCLASSIFIED_CATEGORY;
}

/**
 * Stable keys for default categories (Category.defaultKey). The stored name
 * stays the canonical FR seed name; display goes through the key as long as
 * the user hasn't renamed the category (renaming => defaultKey = null).
 */
export const DEFAULT_CATEGORY_KEYS = [
	'food',
	'dining',
	'transport',
	'housing',
	'bills_energy',
	'health',
	'leisure',
	'subscriptions',
	'shopping',
	'travel',
	'income',
	'savings',
	'investment',
	'other'
] as const;

export type DefaultCategoryKey = (typeof DEFAULT_CATEGORY_KEYS)[number];
