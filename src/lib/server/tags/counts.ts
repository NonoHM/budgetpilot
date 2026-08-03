import { prisma } from '$lib/server/db';
import type { Prisma } from '../database/types.ts';

export interface TagScopeCount {
	tagId: string;
	count: number;
}

/**
 * Counts, per tag, how many transactions in `where` carry it.
 *
 * `where` MUST already have the tag conjunct removed by the caller (`+page.server.ts`'s `load`
 * strips it before calling this). Counting inside the tag dimension's own filter would report 1
 * for the currently-selected tag and 0 for every other one, which is not a comparison against the
 * rest of the filtered set, it is a tautology.
 *
 * `TransactionTag` carries no `userId` column of its own: its two foreign keys
 * (`transactionId`, `tagId`) are independent, so nothing in the schema stops a row linking one
 * user's transaction to another user's tag. Scoping through BOTH `transaction: { userId }` AND
 * `tag: { userId }` is the ENTIRE protection against a cross-tenant count leaking through here —
 * dropping either conjunct opens it back up.
 */
export async function countTagsInScope(
	userId: string,
	where: Prisma.TransactionWhereInput
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
