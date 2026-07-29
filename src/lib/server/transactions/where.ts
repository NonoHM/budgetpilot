import { isHttpError } from '@sveltejs/kit';
import type { Prisma } from '@prisma/client';
import { parseCustomDateRange } from '$lib/server/date-range';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { prisma } from '$lib/server/db';

export type TransactionFilter = 'all' | 'income' | 'expense' | 'classify';

/**
 * Resolves the userId-scoped id of the "Non catégorisé" (UNCLASSIFIED_CATEGORY) category row.
 * Backed by the unique (userId, name) index — a fast point lookup, not a scan. Used so the
 * "to classify" pile can be filtered by categoryId equality in SQL instead of a name join.
 */
export async function resolveUncategorizedCategoryId(userId: string): Promise<string | null> {
	const category = await prisma.category.findFirst({
		where: { userId, nameKey: computeNameKey(UNCLASSIFIED_CATEGORY) },
		select: { id: true }
	});
	return category?.id ?? null;
}

export function buildTransactionWhere(input: {
	userId: string;
	type: TransactionFilter;
	category: string;
	from?: Date;
	to?: Date;
	importBatchId: string;
	/**
	 * Resolved id of the "Non catégorisé" category (see resolveUncategorizedCategoryId).
	 * Required when type === 'classify'; null is treated as "match nothing" for that branch
	 * (the sentinel category should always exist, but this keeps the where well-defined).
	 */
	uncategorizedCategoryId?: string | null;
}): Prisma.TransactionWhereInput {
	const where: Prisma.TransactionWhereInput = { userId: input.userId };
	// Effective-category equality (manualCategory ?? category.name) can produce two OR-shaped
	// conditions (classify pile, category text filter) that must be ANDed together, not
	// overwrite one another — combined via `AND` below instead of both writing `where.OR`.
	const conditions: Prisma.TransactionWhereInput[] = [];

	if (input.type === 'classify') {
		conditions.push({
			OR: [
				{ manualCategoryKey: computeNameKey(UNCLASSIFIED_CATEGORY) },
				{
					AND: [
						{ manualCategory: null },
						{ categoryId: input.uncategorizedCategoryId ?? '__none__' }
					]
				}
			]
		});
	} else if (input.type === 'income' || input.type === 'expense') {
		where.type = input.type;
	}

	if (input.category) {
		conditions.push({
			OR: [
				{ manualCategoryKey: computeNameKey(input.category) },
				{
					AND: [
						{ manualCategory: null },
						{
							category: {
								is: { userId: input.userId, nameKey: computeNameKey(input.category) }
							}
						}
					]
				}
			]
		});
	}
	if (input.importBatchId) where.importBatchId = input.importBatchId;
	if (input.from && input.to) {
		where.date = { gte: input.from, lt: input.to };
	}
	// A single OR-condition keeps the historical `where.OR` shape (both branches are equivalent
	// combined with the rest of `where` via implicit AND); only ANDed explicitly once the classify
	// pile and the category text filter are both active, so neither silently overwrites the other.
	if (conditions.length === 1) {
		where.OR = conditions[0].OR;
	} else if (conditions.length > 1) {
		where.AND = conditions;
	}

	return where;
}

export function normalizeSearch(value: string | null): string {
	return (value ?? '').trim().slice(0, 120);
}

export function normalizeId(value: string | null): string {
	const normalized = (value ?? '').trim();
	return /^[a-z0-9_-]{8,}$/i.test(normalized) ? normalized : '';
}

export function parseTransactionFilter(value: string | null): TransactionFilter {
	if (value === 'income' || value === 'expense' || value === 'classify') return value;
	return 'all';
}

// Wraps parseCustomDateRange so a lone "from" or "to" (or an invalid/reversed pair) degrades to
// a blocking inline error instead of crashing the page/export — mirrors the queryError pattern
// already used for invalid regex search on /transactions.
export function parseTransactionDateRange(
	fromParam: string | null,
	toParam: string | null
): { range: { from: Date; to: Date; fromDate: string; toDate: string } | null; error: boolean } {
	if (!fromParam && !toParam) return { range: null, error: false };
	try {
		return { range: parseCustomDateRange(fromParam, toParam), error: false };
	} catch (err) {
		if (isHttpError(err)) return { range: null, error: true };
		throw err;
	}
}
