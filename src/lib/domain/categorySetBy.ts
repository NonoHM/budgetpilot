/**
 * Who set a transaction's pin (`manualCategory`), #1013: the member, a rule, or `unknown`, and
 * `null` when the row carries no pin and its category is the file's own (`categoryId`).
 *
 * The one reader. A learner that may only learn from the member's choices (#1009) asks this, never
 * the raw column, because the column alone can be stale: 1.3 writes the pin and its key but not
 * its author, so after a rollback to 1.3 and back a pin can carry an author written for another
 * pin. The author therefore counts only for the key it was written for, and anything else reads
 * `unknown`, which is the direction that keeps a row out of learning. One case it cannot see:
 * 1.3 clears a pin and then re-sets the same name, so the key matches again; the operator closes it
 * with `scripts/reset-category-authors.mjs` after rolling forward (owner ruling on #1013).
 *
 * `acceptedSuggestion` is the member accepting a proposal, kept apart from `member` because every
 * proposal today is a rule's output, and learning from it would reinforce the rule (#1009 R10).
 */
export const CATEGORY_SET_BY = ['member', 'rule', 'acceptedSuggestion'] as const;
export type CategorySetBy = (typeof CATEGORY_SET_BY)[number];

export function categorySetBy(row: {
	manualCategoryKey: string | null;
	manualCategorySource: CategorySetBy | null;
	manualCategorySourceKey: string | null;
}): CategorySetBy | 'unknown' | null {
	if (row.manualCategoryKey === null) return null;
	if (row.manualCategorySource === null) return 'unknown';
	return row.manualCategorySourceKey === row.manualCategoryKey
		? row.manualCategorySource
		: 'unknown';
}
