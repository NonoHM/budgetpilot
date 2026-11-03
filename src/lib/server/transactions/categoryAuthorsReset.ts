import type { PrismaClient } from '../database/types.ts';

/**
 * Forgets who set every pin, on every member (#1013): each author reads unknown afterwards and no
 * pin, category or figure changes. The operator runs it after rolling forward from a rollback to
 * 1.3, through `scripts/reset-category-authors.mjs`, because 1.3 writes pins without their author
 * and one case of that cannot be told apart on the row: 1.3 clears a pin, then re-sets the same
 * name, so the stale author's key matches again (owner ruling on #1013).
 *
 * Instance-wide by design: the rollback was, and the operator, not a member, runs it.
 */
export async function resetCategoryAuthors(
	prisma: Pick<PrismaClient, 'transaction'>,
	{ dryRun }: { dryRun: boolean }
): Promise<number> {
	const where = { manualCategorySource: { not: null } } as const;
	if (dryRun) return prisma.transaction.count({ where });
	const reset = await prisma.transaction.updateMany({
		where,
		data: { manualCategorySource: null, manualCategorySourceKey: null }
	});
	return reset.count;
}
