import { DEFAULT_CATEGORIES } from './defaults';
import { DEFAULT_CATEGORY_LABELS } from '$lib/domain/categoryLabels';
import { computeNameKey } from '$lib/server/naming/nameKey';

/**
 * The offer #162 owes the user, computed rather than stored.
 *
 * #162 made a category's stored name its only name. An English reader who saw "Groceries" before
 * that change sees "Alimentation" after it, because the row was always stored that way and the
 * translation is gone. That is the accepted cost of the design, and this module is what makes it
 * recoverable: it works out which seeded rows would read differently in the language being read,
 * and offers to rename them into it, once, through the same code path a manual rename uses.
 *
 * ## Why every part of this is derived
 *
 * Nothing here is persisted except the user's refusal. The question "should this be offered" is a
 * VERDICT ON THE PRESENT: it depends on what the categories are called right now and on which
 * language this request is being rendered in, and both can change after any answer. A stored
 * "prompt done" flag would go stale in both directions, offering a rename already performed, or
 * staying silent for a user who switched language in `/settings` afterwards.
 *
 * So accepting the offer writes no flag. It stops appearing because the rows it was about no
 * longer match, which is the same reason it never appears on a French install: there, all fourteen
 * labels are byte-identical to the stored names, so the plan is empty by construction rather than
 * by a special case.
 */

export type CategoryRenameProposal = {
	id: string;
	/** The name stored today, which is also what the user sees. */
	currentName: string;
	/** The seeded catalogue's label for this category in the locale being rendered. */
	proposedName: string;
};

export type CategoryRenamePlan = {
	proposals: CategoryRenameProposal[];
	/**
	 * Proposals dropped because the user already owns a category under the proposed name.
	 *
	 * Reported rather than silently discarded: renaming "Alimentation" to "Groceries" when a
	 * "Groceries" already exists would either fail on the unique constraint or, worse, be taken as
	 * a request to merge two categories, which is not what a rename prompt is allowed to mean. The
	 * count is what lets the confirmation say how many rows it did not touch.
	 */
	blockedByExistingName: number;
};

/** Folded canonical seeded name to its catalogue key. Built once: the catalogue is static. */
const KEY_BY_SEEDED_NAME_KEY = new Map(
	DEFAULT_CATEGORIES.map((entry) => [computeNameKey(entry.name), entry.key] as const)
);

/**
 * Which of a user's categories would read differently in the current locale, and what to call them.
 *
 * Folded on both sides with `computeNameKey`, never compared as raw text, for the reason the rest
 * of this directory folds: a row stored as "alimentation" is the seeded "Alimentation" and must be
 * offered the same rename, and a raw SQL equality would answer differently on MariaDB than on the
 * other two engines.
 *
 * Reads the locale through `DEFAULT_CATEGORY_LABELS`, so it must be called inside a request. There
 * is no request context in a unit test or a Playwright node process, where paraglide renders the
 * BASE locale; specs that care pin it explicitly.
 */
export function planDefaultCategoryRenames<T extends { id: string; name: string }>(
	categories: readonly T[]
): CategoryRenamePlan {
	const existingKeys = new Set(categories.map((category) => computeNameKey(category.name)));
	const proposals: CategoryRenameProposal[] = [];
	// Every name already claimed by a proposal ahead of this one. The fourteen labels are distinct
	// in both catalogues today, checked, so this is empty in practice; it exists because the
	// catalogue is a translated file and two entries colliding is a one-word edit away. Without it
	// that edit would not produce a duplicate proposal, it would produce a unique-constraint
	// failure that rolls back the whole rename, which is a far worse way to find out.
	const claimedKeys = new Set<string>();
	let blockedByExistingName = 0;

	for (const category of categories) {
		const currentKey = computeNameKey(category.name);
		const defaultKey = KEY_BY_SEEDED_NAME_KEY.get(currentKey);
		if (!defaultKey) continue;

		const proposedName = DEFAULT_CATEGORY_LABELS[defaultKey]();
		const proposedKey = computeNameKey(proposedName);

		// The label is what is already stored. True of all fourteen on a French install, and of
		// "Transport" and "Shopping" in English, which are spelled the same in both. Nothing to
		// offer, and offering it would propose a rename that changes nothing.
		if (proposedKey === currentKey) continue;

		// Taken by a category that is NOT this one. `existingKeys` holds every category the user
		// owns, and `currentKey` is in it by construction, which is why the equality above has to
		// come first: without it this branch would count every no-op proposal as blocked.
		if (existingKeys.has(proposedKey) || claimedKeys.has(proposedKey)) {
			blockedByExistingName += 1;
			continue;
		}

		claimedKeys.add(proposedKey);
		proposals.push({ id: category.id, currentName: category.name, proposedName });
	}

	return { proposals, blockedByExistingName };
}
