import { computeNameKey } from '../naming/nameKey.ts';
import type { prisma } from '../db.ts';

/**
 * The client Prisma hands an interactive transaction callback. Derived from `$transaction`'s own
 * signature rather than imported from a generated namespace: there are three generated clients
 * (one per provider) and only this form stays correct for whichever one is built.
 */
type TransactionClient = Parameters<Parameters<(typeof prisma)['$transaction']>[0]>[0];

/**
 * A category's NAME is a de facto foreign key.
 *
 * Five columns across five tables reference a category by its text rather than by its id, so
 * renaming a category is not a single-row update: every one of them has to move with it, or the
 * reference dangles and the row it belongs to silently stops matching the category it names.
 *
 * The defect this module exists to prevent was measured, not imagined. `?/renameCategory` used to
 * update three of the five, and renaming "Loisirs" to "Sorties" left `MonthlyBudget.categoryName`
 * at "Loisirs" — so `/budgets` went on showing a budget for a category that no longer exists,
 * tracking **0 spent** against real spending in the renamed one. A false money figure on screen,
 * with nothing to point at.
 *
 * The second-order effect was worse than the first. `applyCategoryRules` writes
 * `manualCategory: rule.targetCategory` verbatim, so a rule left pointing at "Loisirs" keeps
 * pinning a name no `Category` row holds onto NEW transactions: it shows on rows, it has no
 * `defaultKey` so it is never translated, and it appears in no category list. The rename did not
 * only break the past, it kept writing the dead name into the future.
 *
 * ## Why an inventory rather than five `updateMany` calls at the call site
 *
 * A list of edits at one call site is a list of what its author happened to think of — the exact
 * shape that produced the bug. `CATEGORY_NAME_REFERENCES` is the inventory, `references.spec.ts`
 * asserts it against `prisma/schema.prisma` itself, so a sixth column added to the schema fails a
 * test naming the column instead of silently inheriting a fourth of a fix.
 *
 * ## Why two of the five are matched differently
 *
 * Three carry a companion `*Key` column (`computeNameKey` of the name), so they are matched with a
 * keyed `updateMany`: every spelling the user pinned follows the rename, not only the one that
 * matched the old name character for character.
 *
 * The two rule tables carry no key column. They are read and filtered through `computeNameKey` in
 * JS **inside the same transaction**, so the fold is identical to the keyed paths — a rule stored
 * as "loisirs" belongs to the "Loisirs" being renamed and must follow it. Doing the read outside
 * the transaction would leave a window in which a rule created between the read and the write
 * keeps the old name, which is the same dangling reference one race narrower.
 */

/**
 * Every column that stores a category NAME as data, with the key column that folds it.
 *
 * `keyColumn: null` means the table has no companion key and must be matched in JS. Adding a
 * column here is not optional bookkeeping: `renameCategoryReferences` iterates this list, and
 * `references.spec.ts` cross-checks it against the schema.
 */
export const CATEGORY_NAME_REFERENCES = [
	{ model: 'Transaction', column: 'manualCategory', keyColumn: 'manualCategoryKey' },
	{ model: 'MonthlyBudget', column: 'categoryName', keyColumn: 'categoryNameKey' },
	{ model: 'CategoryNatureMapping', column: 'categoryName', keyColumn: 'categoryNameKey' },
	{ model: 'CategoryRule', column: 'targetCategory', keyColumn: null },
	{ model: 'CategorizationRule', column: 'targetCategory', keyColumn: null }
] as const;

/**
 * Repoints every stored reference to `oldKey` at `newName`, inside the caller's transaction.
 *
 * Takes a transaction client rather than opening its own: the category row's own rename and these
 * five must be one atomic unit. A partial success is the defect, not a degraded version of the fix
 * — a budget left behind is exactly what produced the 0-cents figure.
 */
export async function renameCategoryReferences(
	tx: TransactionClient,
	params: { userId: string; oldKey: string; newName: string; newKey: string }
): Promise<void> {
	const { userId, oldKey, newName, newKey } = params;

	// The three keyed tables: matched on the key, so every spelling follows.
	await tx.transaction.updateMany({
		where: { userId, manualCategoryKey: oldKey },
		data: { manualCategory: newName, manualCategoryKey: newKey }
	});
	await tx.monthlyBudget.updateMany({
		where: { userId, categoryNameKey: oldKey },
		data: { categoryName: newName, categoryNameKey: newKey }
	});
	await tx.categoryNatureMapping.updateMany({
		where: { userId, categoryNameKey: oldKey },
		data: { categoryName: newName, categoryNameKey: newKey }
	});

	// The two keyless rule tables: read and folded in JS, in this same transaction.
	//
	// Selecting id + name rather than filtering in SQL is deliberate, and it was measured rather
	// than assumed. `targetCategory` has no key column, so a SQL equality on the raw text is decided
	// by the column's collation: `WHERE targetCategory = 'Loisirs'` against a row stored as
	// "loisirs" returns 1 row on MariaDB 11 and 0 rows on SQLite and PostgreSQL 17. A rename that
	// matched in SQL would therefore repoint the rule on one engine and orphan it on the other two.
	// Folding here gives the same answer everywhere.
	//
	// Both scans are bounded by what the user authored through a UI that lists every rule on one
	// page, and `/rules`' own load already reads them unbounded.
	const [categoryRules, categorizationRules] = await Promise.all([
		tx.categoryRule.findMany({ where: { userId }, select: { id: true, targetCategory: true } }),
		tx.categorizationRule.findMany({
			where: { userId },
			select: { id: true, targetCategory: true }
		})
	]);

	const categoryRuleIds = categoryRules
		.filter((rule) => computeNameKey(rule.targetCategory) === oldKey)
		.map((rule) => rule.id);
	const categorizationRuleIds = categorizationRules
		.filter((rule) => computeNameKey(rule.targetCategory) === oldKey)
		.map((rule) => rule.id);

	if (categoryRuleIds.length > 0) {
		await tx.categoryRule.updateMany({
			// `userId` restated on the write even though the ids came from a scoped read: the scan
			// and the write are two queries and only the one on the WRITE is a protection.
			where: { id: { in: categoryRuleIds }, userId },
			data: { targetCategory: newName }
		});
	}
	if (categorizationRuleIds.length > 0) {
		await tx.categorizationRule.updateMany({
			where: { id: { in: categorizationRuleIds }, userId },
			data: { targetCategory: newName }
		});
	}
}

/**
 * The user's category names, folded, as the set a rule's `targetCategory` is resolved against.
 *
 * ## Why a rule's target is DERIVED rather than a stored flag (issue #161)
 *
 * `?/deleteCategory` used to treat three of the five columns above as data and leave the two rule
 * tables pointing at a name no `Category` row carried. That is worse than an orphan row, because
 * `applyCategoryRules` writes `manualCategory: rule.targetCategory` verbatim: the next rules run
 * put the deleted name back onto transactions, including the very ones the delete had just moved
 * to the fallback. The delete did not merely leave debris, it left a mechanism that reversed
 * itself.
 *
 * The fix disables the rule rather than deleting it (the pattern is user-authored work) or
 * repointing it at "Non catégorisé" (a claim the user never made, applied to every future import).
 * What is deliberately NOT done is storing that disabled state.
 *
 * A stored `disabledReason` written at delete time is a claim about the past that the present can
 * falsify: recreate a category under the deleted name and the rule stays paused, under a sentence
 * saying its target was deleted, which is no longer true. That is the `/upcoming-bills` shape this
 * project keeps closing, a screen stating the one thing that stopped being so. It would also give
 * `enabled` two meanings at once, the user's own switch and a system verdict, with a second column
 * as discriminator: the `Category.name` + `defaultKey` shape that produced five wrong display
 * sites.
 *
 * Deriving it costs one bounded read and buys four properties outright. It cannot go stale, so
 * recreating the category resumes the rule. A restored backup naming an absent category arrives
 * paused by construction, which is why `backup/import.ts` needs no validation for this and refuses
 * nothing (a restore is one of the three write paths that habitually bypass the service, and here
 * there is no service state to bypass). Re-enabling a paused rule from `/rules` cannot resurrect
 * the defect, because `enabled` is not the gate that decides. And the delete stays all-or-none
 * without trying: nothing is added to its `$transaction`, so the window in which a category is
 * gone and its rules are not yet paused does not exist rather than being closed.
 *
 * ## Why the fold is in JS and never a SQL equality
 *
 * The same reason `renameCategoryReferences` gives above, and it is the same measurement:
 * `targetCategory` has no key column, so `WHERE targetCategory = 'Loisirs'` against a row stored
 * as "loisirs" returns 1 row on MariaDB 11 and 0 rows on SQLite and PostgreSQL 17. A rule would
 * pause on one engine and go on writing the dead name on the other two.
 *
 * Bounded by what the user authored through a UI that lists every category on one page, and every
 * caller either already reads its categories (`/rules`, `/categories`) or reads every rule
 * unbounded anyway.
 */
export async function readCategoryNameKeys(
	client: TransactionClient,
	userId: string
): Promise<Set<string>> {
	return toCategoryNameKeys(
		await client.category.findMany({ where: { userId }, select: { name: true } })
	);
}

/**
 * The same fold, for a caller that already holds the rows.
 *
 * `/transactions`, `/rules` and `/categories` all load their categories for other reasons, so they
 * pay nothing for this. It exists as its own function rather than as a `new Set(...map(...))` at
 * each of them because the fold is the part that has to agree with `renameCategoryReferences`, and
 * a decision restated at four call sites is one that drifts at three of them.
 */
export function toCategoryNameKeys(categories: ReadonlyArray<{ name: string }>): Set<string> {
	return new Set(categories.map((category) => computeNameKey(category.name)));
}

/**
 * Whether a rule's target still resolves to one of the user's categories.
 *
 * A rule that answers false is PAUSED: it keeps its row, keeps its pattern, and does not fire.
 * Every site that reads a rule has to ask this, and there are four, which is one more than the
 * issue listed. Three are obvious once stated: `applyCategoryRules` writes the name, so it is the
 * defect itself; `previewCategoryRules` counts what that write would do, and a preview that
 * disagrees with the apply is a false promise; `/import` feeds `applyCategorizationRules` for the
 * legacy table.
 *
 * The fourth is `/transactions`' own load, and it was missed because nothing there writes
 * anything. It reads enabled rules to tell a row and the detail panel that a rule matches this
 * transaction. Leaving a paused rule in that list makes the page promise a categorisation that
 * cannot happen, which is the same false-claim shape as the write, minus the write.
 *
 * Pure and separate from the read above so it can be exercised without a database: the fold is the
 * part that has to agree with `renameCategoryReferences`, and agreement is what a unit test can
 * actually pin.
 */
export function isRuleTargetLive(
	targetCategory: string,
	categoryNameKeys: ReadonlySet<string>
): boolean {
	return categoryNameKeys.has(computeNameKey(targetCategory));
}
