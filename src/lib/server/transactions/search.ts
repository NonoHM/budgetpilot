import type { Prisma } from '../database/types.ts';
import { normalizeForMatch } from '$lib/domain/normalize';
import { isSafeRegexPattern, safeRegexTest } from '$lib/server/matching/regex';
import { forEachTransactionBatch } from '$lib/server/transactions/batch';

export type QueryMode = 'contains' | 'regex';

const MAX_QUERY_LENGTH = 120;

export function parseQueryMode(value: string | null): QueryMode {
	return value === 'regex' ? 'regex' : 'contains';
}

export function isValidRegexQuery(pattern: string): boolean {
	return isSafeRegexPattern(pattern, MAX_QUERY_LENGTH);
}

export function matchesQuery(label: string, query: string, mode: QueryMode): boolean {
	if (mode === 'regex') return safeRegexTest(query, 'i', label);
	return normalizeForMatch(label).includes(normalizeForMatch(query));
}

export function filterTransactionsByQuery<T extends { label: string }>(
	transactions: T[],
	query: string,
	mode: QueryMode
): T[] {
	if (!query) return transactions;
	return transactions.filter((t) => matchesQuery(t.label, query, mode));
}

/**
 * Scans `where`-matching transactions in bounded batches (see forEachTransactionBatch),
 * filtering each batch by `query`/`mode` (label search can't be expressed in SQL — accent
 * normalization/regex) and accumulating every match. Equivalent to the previous
 * "findMany then filter in memory" but never materializes the full unfiltered candidate set
 * from a single Prisma query.
 */
export async function collectTransactionsMatchingQuery<
	Select extends Prisma.TransactionSelect & { label: true }
>(
	where: Prisma.TransactionWhereInput,
	select: Select,
	query: string,
	mode: QueryMode
): Promise<Array<Prisma.TransactionGetPayload<{ select: Select }>>> {
	type Row = Prisma.TransactionGetPayload<{ select: Select }> & { label: string };
	const matches: Row[] = [];
	await forEachTransactionBatch(where, select, (rows) => {
		matches.push(...filterTransactionsByQuery(rows as Row[], query, mode));
	});
	return matches;
}
