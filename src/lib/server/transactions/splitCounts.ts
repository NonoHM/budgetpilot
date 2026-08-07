import { prisma } from '$lib/server/db';
import type { Prisma } from '../database/types.ts';

/**
 * How many transaction ids may travel back into a single `IN (...)`.
 *
 * Same figure and same reasoning as `ID_CHUNK_SIZE` in `tags/counts.ts`, and deliberately a second
 * constant rather than an import: that one bounds a per-TAG groupBy, this one bounds a pair of
 * counts. They coincide today and are free to diverge.
 */
const ID_CHUNK_SIZE = 250;

export interface SplitOptionCounts {
	splitCount: number;
	unsplitCount: number;
}

/**
 * Does this user have ANY répartition at all?
 *
 * Answers the "should the filter exist on this page" question, and it is deliberately a different
 * question from the per-option counts below. The control is not rendered until the answer is yes —
 * ni grisé, ni "aucune répartition" — because a visible filter teaches a feature in a toolbar, to
 * someone who came looking for something else. Once the answer is yes it stays rendered for the
 * whole visit even if the current scope contains none, which is what the counts are for.
 *
 * Scoped to the user's own transactions: `TransactionSplit` has no `userId` column, so the reach
 * through `transaction: { userId }` is the entire tenancy guarantee here, exactly as in
 * `tags/counts.ts`.
 */
export async function userHasAnySplit(userId: string): Promise<boolean> {
	const found = await prisma.transactionSplit.findFirst({
		where: { transaction: { userId } },
		select: { id: true }
	});
	return found !== null;
}

/**
 * Counts, for the current scope, how many transactions are répartie and how many are not.
 *
 * `where` MUST already have the répartition conjunct removed by the caller — `resolveTransactionScope`
 * BUILDS a split-free predicate for this, never destructures one off `where`. Counting inside the
 * dimension's own filter is the tautology `countTagsInScope` documents at length: with
 * `?split=split` active it would report the whole set under "Répartie" and 0 under "Non répartie",
 * which is not a comparison, it is the filter describing itself.
 *
 * The two counts are taken over the same scope in one round trip each, rather than derived as
 * `total - splitCount`. Subtraction would be correct only while the two predicates partition the
 * scope exactly, and the moment anything else constrains the relation — the classify pile already
 * does — the remainder stops meaning "not répartie".
 *
 * @param restrictToIds when `?q=` is active, the ids the JS match actually admitted. `q` is matched
 * in JS after the SQL query, so counting over the raw `where` while a search is active counts a
 * STRICT SUPERSET of what the user is looking at — the defect `bulkTag` shipped with.
 */
export async function countSplitsInScope(
	userId: string,
	where: Prisma.TransactionWhereInput,
	restrictToIds?: string[] | null
): Promise<SplitOptionCounts> {
	// `userId` spread LAST so a caller-supplied one can only ever narrow, never widen. Same rule,
	// same reason, as countTagsInScope.
	const scopedWhere: Prisma.TransactionWhereInput = { ...where, userId };

	if (!restrictToIds) {
		return countPair(scopedWhere);
	}

	// De-duplicated here rather than trusted from the caller: within one chunk a repeated id is
	// harmless because `IN` is a set, but across two chunks it is counted twice and the result is an
	// inflated number with nothing to notice it by.
	const ids = [...new Set(restrictToIds)];
	if (ids.length === 0) return { splitCount: 0, unsplitCount: 0 };

	const totals = { splitCount: 0, unsplitCount: 0 };
	for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
		const chunk = await countPair({
			...scopedWhere,
			id: { in: ids.slice(start, start + ID_CHUNK_SIZE) }
		});
		totals.splitCount += chunk.splitCount;
		totals.unsplitCount += chunk.unsplitCount;
	}
	return totals;
}

async function countPair(where: Prisma.TransactionWhereInput): Promise<SplitOptionCounts> {
	const [splitCount, unsplitCount] = await Promise.all([
		prisma.transaction.count({ where: { AND: [where, { splits: { some: {} } }] } }),
		prisma.transaction.count({ where: { AND: [where, { splits: { none: {} } }] } })
	]);
	return { splitCount, unsplitCount };
}
