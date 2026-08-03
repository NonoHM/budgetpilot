import { prisma } from '$lib/server/db';
import type { Prisma } from '../database/types.ts';

export interface TagScopeCount {
	tagId: string;
	count: number;
}

/**
 * How many transaction ids may travel back into a single `IN (...)`.
 *
 * The same figure and the same reasoning as `MAX_TRANSACTION_ID_FILTER` in
 * `server/transactions/where.ts`: this layer owes the query planner a bounded `IN`. It is not
 * imported from there because that constant bounds what a URL may ASK for, while this one bounds
 * what we choose to SEND — they happen to coincide today and are free to diverge.
 *
 * Above this, the id set is chunked and the per-tag counts are summed, rather than the count being
 * abandoned. Abandoning it is what the first version did, and it degrades in a way nobody would
 * ever notice was wrong: a search matching 300 rows is entirely ordinary, so "comptes
 * indisponibles" would have become the normal state for anyone with a few thousand transactions.
 */
const ID_CHUNK_SIZE = 250;

/**
 * Counts, per tag, how many transactions in `where` carry it.
 *
 * `where` MUST already have the tag conjunct removed by the caller (`+page.server.ts`'s `load`
 * strips it before calling this). Counting inside the tag dimension's own filter would report 1
 * for the currently-selected tag and 0 for every other one, which is not a comparison against the
 * rest of the filtered set, it is a tautology.
 *
 * Note that strip works only because `buildTransactionWhere` puts the tag filter at the TOP LEVEL
 * as `where.tags`, rather than inside the OR-shaped `conditions`. If a future filter ever moves it
 * into `AND`/`OR`, the caller's rest-spread silently stops removing it and these counts silently
 * become the tautology above — with nothing going red.
 *
 * `TransactionTag` carries no `userId` column of its own: its two foreign keys
 * (`transactionId`, `tagId`) are independent, so nothing in the schema stops a row linking one
 * user's transaction to another user's tag. Scoping through BOTH `transaction: { userId }` AND
 * `tag: { userId }` is the ENTIRE protection against a cross-tenant count leaking through here —
 * dropping either conjunct opens it back up.
 *
 * Both conjuncts are applied HERE rather than trusted from the caller. The first version passed
 * `where` through verbatim and applied `userId` to the tag side alone, so half of the protection
 * this docstring calls "the ENTIRE protection" was in fact whatever the caller happened to pass.
 * That was correct for the one caller and silently wrong for the next. `userId` is spread LAST so
 * a caller-supplied `userId` cannot override it — it can only ever narrow.
 *
 * @param restrictToIds when the `?q=` search is active, the ids the JS match actually admitted.
 * `q` is matched in JS AFTER the SQL query (accent folding and regex are not expressible in SQL),
 * so counting over the raw `where` while a search is active counts a STRICT SUPERSET of what the
 * user is looking at — the exact bug `bulkTag` shipped with.
 */
export async function countTagsInScope(
	userId: string,
	where: Prisma.TransactionWhereInput,
	restrictToIds?: string[] | null
): Promise<TagScopeCount[]> {
	const scopedWhere: Prisma.TransactionWhereInput = { ...where, userId };

	if (!restrictToIds) return groupByTag(scopedWhere, userId);

	if (restrictToIds.length === 0) return [];

	const totals = new Map<string, number>();
	for (let i = 0; i < restrictToIds.length; i += ID_CHUNK_SIZE) {
		const chunk = restrictToIds.slice(i, i + ID_CHUNK_SIZE);
		for (const row of await groupByTag({ ...scopedWhere, id: { in: chunk } }, userId)) {
			totals.set(row.tagId, (totals.get(row.tagId) ?? 0) + row.count);
		}
	}
	// Summing across chunks is exact rather than approximate: the chunks partition a set of
	// distinct transaction ids, so no transaction is counted by two chunks.
	return [...totals].map(([tagId, count]) => ({ tagId, count }));
}

async function groupByTag(
	where: Prisma.TransactionWhereInput,
	userId: string
): Promise<TagScopeCount[]> {
	const rows = await prisma.transactionTag.groupBy({
		by: ['tagId'],
		where: {
			transaction: where,
			tag: { userId }
		},
		_count: { _all: true }
	});
	return rows.map((row) => ({ tagId: row.tagId, count: row._count._all }));
}
