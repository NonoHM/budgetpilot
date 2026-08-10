import * as m from '$lib/paraglide/messages';
import { locales } from '$lib/paraglide/runtime';
import { categoryLabel } from '$lib/domain/categoryLabels';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { computeNameKey } from '$lib/server/naming/nameKey';

/**
 * The one definition of "these two names are the same category to the user".
 *
 * `computeNameKey` alone answers a narrower question than the app needs. It folds case and
 * accents, so "Courses" and "courses" are one name on every engine — but it is computed from
 * the STORED name, and a seeded default category is not displayed under its stored name. The
 * fourteen defaults are stored under canonical French names and rendered through
 * `categoryLabel()`, so on an English instance the row stored as "Alimentation" reads
 * "Groceries" everywhere the user can see it.
 *
 * The consequence was a false promise rather than a cosmetic one. `/categories` states that a
 * category name must be unique, and creating "Groceries" on an English instance SUCCEEDED,
 * because nothing stored was called Groceries. The list then showed two rows a reader takes
 * for one category, and every budget, report, rule and split divided silently between them.
 * Same family as the `/budgets` defect #126 closed — two places disagreeing about what a
 * category's name is. That one was case; this one is locale.
 *
 * So a category answers to TWO names: the one in the column and the one on the screen. They
 * coincide for anything the user typed themselves (`defaultKey` is null, and renaming a
 * default clears it), which is why the second key is emitted only when it differs.
 *
 * LOCALE-DEPENDENT BY CONSTRUCTION, and that is the point rather than a defect: the question
 * being asked is "does this collide with a name the user can see", and what they can see is
 * decided by the language they are reading in. It is therefore a CHECK and never a stored
 * value — `Category.nameKey` stays the fold of the stored name, because it carries the unique
 * constraint and the joins to budgets, nature mappings and pinned manual categories, none of
 * which may move when somebody switches language in `/settings`.
 *
 * Not applied to `resolveCategoryByName`, deliberately: that get-or-create is reached by CSV
 * import, bank import and backup restore, where the same file must produce the same categories
 * whatever language the session happens to be in. Its upsert is keyed on the unique constraint
 * too, which cannot carry a key that changes with the locale.
 */
export type CategoryIdentity = { name: string; defaultKey?: string | null };

/** Every folded key this category answers to: the stored name, and the displayed label. */
export function categoryNameKeys(category: CategoryIdentity): string[] {
	const stored = computeNameKey(category.name);
	const displayed = computeNameKey(categoryLabel(category.name, category.defaultKey ?? null));
	return stored === displayed ? [stored] : [stored, displayed];
}

/**
 * The category a name the user just typed already belongs to, or `undefined`.
 *
 * Only the stored side is expanded. A typed name is one name — whatever the user wrote — and
 * expanding it would ask whether some translation of what they typed collides, which is not a
 * question anyone is asking.
 */
export function findCategoryByTypedName<T extends CategoryIdentity>(
	typedName: string,
	categories: readonly T[]
): T | undefined {
	const typedKey = computeNameKey(typedName);
	return categories.find((category) => categoryNameKeys(category).includes(typedKey));
}

/** Whether two categories are the same name to the user, in either direction. */
export function categoriesCollide(a: CategoryIdentity, b: CategoryIdentity): boolean {
	const keys = new Set(categoryNameKeys(a));
	return categoryNameKeys(b).some((key) => keys.has(key));
}

/**
 * The "to classify" pile's slug and its label in EVERY locale, not only the one being read.
 *
 * Deliberately stricter than the uniqueness check above, and the asymmetry is the point. That
 * check asks what collides TODAY, so it has to be locale-dependent — a French user may
 * legitimately want a category called "Groceries", and refusing it would be a new defect rather
 * than a fix. The pile is not that: it can never be renamed, its label belongs to the app, and
 * nobody has a use for a category named "Non catégorisé" on an English instance. Allowing one
 * only defers the collision to the day that user switches language in `/settings`, at which
 * point two rows read as the pile and one of them is not.
 *
 * Measured through the real request path before this existed: `Non catégorisé` typed on an
 * English instance was created, while `Uncategorized` was refused.
 */
export function isReservedCategoryName(name: string): boolean {
	const typed = computeNameKey(name);
	if (typed === computeNameKey(UNCLASSIFIED_CATEGORY)) return true;
	return locales.some(
		(locale) => computeNameKey(m.common_category_uncategorized({}, { locale })) === typed
	);
}
