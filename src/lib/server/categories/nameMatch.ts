import * as m from '$lib/paraglide/messages';
import { locales } from '$lib/paraglide/runtime';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { computeNameKey } from '$lib/server/naming/nameKey';

/**
 * The one definition of "these two names are the same category to the user".
 *
 * `computeNameKey` alone, and after #162 that is the whole story: it folds case and accents, so
 * "Courses" and "courses" are one name on every engine, and a category answers to exactly one
 * name because the stored name is the one on screen.
 *
 * ## What used to be here, and why it is gone
 *
 * A category used to answer to TWO names. The fourteen seeded defaults were stored under canonical
 * French names and rendered through a translation, so on an English instance the row stored as
 * "Alimentation" read "Groceries" everywhere the user could see it. This module expanded every
 * category to both keys, because a uniqueness check that only knew the stored one let a user
 * create "Groceries" beside a row already reading Groceries, and the list then showed two rows a
 * reader takes for one category while every budget, report, rule and split divided silently
 * between them.
 *
 * That check was correct and the model underneath it was not. It made the answer to "does this
 * name already exist" depend on the language being read, which is a strange property for a
 * database to have: the same two rows collided or did not depending on who was looking. #162
 * removed the second name instead of the check, so the question is now locale-INDEPENDENT and
 * this module reads one key per category.
 *
 * ## The one thing here that still spans locales, deliberately
 *
 * `isReservedCategoryName` iterates every compiled locale. That is not a leftover of the old
 * model and it is not the same shape: it does not ask what a category is CALLED in the current
 * language, it refuses a small closed set of names in ALL languages at once. Being
 * locale-complete, it gives the same answer whatever the reader's language, so switching language
 * cannot change what it permits. Locale-DEPENDENT was the defect; locale-COMPLETE is the fix.
 */

/**
 * The category a name the user just typed already belongs to, or `undefined`.
 *
 * Folded on both sides, so "Courses" finds a row stored as "courses". Nothing else: after #162
 * there is no second key to expand either side to, which is why this now agrees by construction
 * with `resolveCategoryByName`'s upsert on `(userId, nameKey)`. Those two used to be deliberately
 * different (the get-or-create reached by CSV import, bank import and backup restore could not
 * use a locale-dependent key, or the same file would produce different categories in different
 * languages), and that exception no longer needs to exist because the rule no longer varies.
 */
export function findCategoryByTypedName<T extends { name: string }>(
	typedName: string,
	categories: readonly T[]
): T | undefined {
	const typedKey = computeNameKey(typedName);
	return categories.find((category) => computeNameKey(category.name) === typedKey);
}

/**
 * The "to classify" pile's slug and its label in EVERY locale, not only the one being read.
 *
 * Deliberately stricter than the uniqueness check above, and the asymmetry is the point. That
 * check asks whether a name is already taken, which is a question about this user's own rows. The
 * pile is not that: it can never be renamed, its label belongs to the app, and nobody has a use
 * for a category named "Non catégorisé" on an English instance. Allowing one only defers the
 * collision to the day that user switches language in `/settings`, at which point two rows read as
 * the pile and one of them is not.
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
