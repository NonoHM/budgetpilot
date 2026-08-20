import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';

/**
 * How many transactions each category actually holds, keyed by `Category.id`.
 *
 * A transaction's category is its EFFECTIVE one — `manualCategory ?? category.name`, the rule
 * `getEffectiveCategory` states and that every money read in this app already obeys. `/categories`
 * used to read `Category._count.transactions` instead, which is `Transaction.categoryId` alone.
 *
 * Those two are not close to each other, and the gap is not an edge case: `manualCategory` is what
 * EVERY categorisation rule writes and what every hand classification writes, while `categoryId`
 * keeps pointing at whatever the import assigned (« Non catégorisé », usually) because the column
 * is NOT NULL and nothing repoints it. So a category built up entirely by rules reported ZERO
 * transactions — measured on the real screen: « Factures & énergie — 0 transactions », deleted with
 * the no-transactions message, eleven categorisations destroyed.
 *
 * TWO grouped reads rather than one count per category, because the page renders every category
 * and a per-row query would be one round trip per row on every load. The two halves mirror the
 * precedence exactly, and the second's `manualCategory: null` is what stops a transaction the user
 * hand-moved elsewhere from being counted under the category it was imported into:
 *
 *   - pinned:    `manualCategoryKey` = the category's `nameKey` — wherever `categoryId` points.
 *   - inherited: `categoryId` = the category, and no manual pin to override it.
 *
 * The join is on the FOLDED KEY, never on displayed text: a rule that wrote "factures" belongs to
 * the "Factures" being counted, exactly as `renameCategoryReferences` treats it, and a raw-text
 * SQL equality would answer differently on MariaDB than on SQLite and PostgreSQL (CLAUDE.md).
 *
 * The key is COMPUTED from the name here rather than read from `Category.nameKey`, which is
 * nullable: a row predating that column would silently match nothing and report zero, which is the
 * exact failure this function exists to remove. Same choice the rule count two lines above it in
 * `/categories`' own load already makes.
 *
 * Split parts are deliberately NOT folded in. This answers « how many transactions », which is what
 * the screen says and what the delete moves; a part's category is guarded separately, and deleting
 * a category referenced by a part is refused outright rather than repointed.
 */
export async function readEffectiveCategoryCounts(userId: string): Promise<Map<string, number>> {
	const [categories, pinned, inherited] = await Promise.all([
		// Read here rather than taken as a parameter, so this function is one await for a caller and
		// can join its existing fan-out instead of waiting behind it. `Category` is small and already
		// indexed by `userId`; `/categories`' own load reading it twice costs less than the round trip
		// this saves, and far less than letting the page and the delete message combine the two halves
		// independently.
		prisma.category.findMany({ where: { userId }, select: { id: true, name: true } }),
		prisma.transaction.groupBy({
			by: ['manualCategoryKey'],
			where: { userId, manualCategoryKey: { not: null } },
			_count: { _all: true }
		}),
		prisma.transaction.groupBy({
			by: ['categoryId'],
			where: { userId, manualCategory: null },
			_count: { _all: true }
		})
	]);

	const pinnedByKey = new Map(
		pinned.map((row) => [row.manualCategoryKey as string, row._count._all])
	);
	const inheritedById = new Map(inherited.map((row) => [row.categoryId, row._count._all]));

	return new Map(
		categories.map((category) => [
			category.id,
			(pinnedByKey.get(computeNameKey(category.name)) ?? 0) + (inheritedById.get(category.id) ?? 0)
		])
	);
}

/**
 * The same figure for ONE category, so the delete's success message and the page's count can never
 * disagree — they are the same computation, not two that happen to match today. The delete used to
 * count `categoryId` alone while its own transaction ALSO cleared every `manualCategoryKey` row
 * three lines below, so it destroyed precisely what it had not counted and then reported the
 * count.
 */
export async function countTransactionsInCategory(
	userId: string,
	categoryId: string
): Promise<number> {
	const counts = await readEffectiveCategoryCounts(userId);
	return counts.get(categoryId) ?? 0;
}
