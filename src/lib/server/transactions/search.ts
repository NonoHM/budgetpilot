import type { Prisma, TransactionPayload } from '../database/types.ts';
import { normalizeForMatch } from '$lib/domain/normalize';
import { compileRegex, isSafeRegexPattern, regexMatches } from '$lib/server/matching/regex';
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
	return queryMatcher(query, mode)(label);
}

// Compiles or normalizes the query once, so a batch of rows pays it once rather than per row.
function queryMatcher(query: string, mode: QueryMode): (label: string) => boolean {
	if (mode === 'regex') {
		const compiled = compileRegex(query);
		return (label) => regexMatches(compiled, label);
	}
	const needle = normalizeForMatch(query);
	return (label) => normalizeForMatch(label).includes(needle);
}

export function filterTransactionsByQuery<T extends { label: string }>(
	transactions: T[],
	query: string,
	mode: QueryMode
): T[] {
	if (!query) return transactions;
	const matches = queryMatcher(query, mode);
	return transactions.filter((t) => matches(t.label));
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
): Promise<Array<TransactionPayload<Select>>> {
	type Row = TransactionPayload<Select> & { label: string };
	const matches: Row[] = [];
	await forEachTransactionBatch(where, select, (rows) => {
		matches.push(...filterTransactionsByQuery(rows as Row[], query, mode));
	});
	return matches;
}
