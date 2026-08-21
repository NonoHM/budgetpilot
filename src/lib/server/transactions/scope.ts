import type { Prisma, TransactionPayload } from '../database/types.ts';
import {
	buildTransactionWhere,
	normalizeId,
	normalizeIdList,
	normalizeSearch,
	parseTransactionDateRange,
	parseTransactionFilter,
	parseTransactionSplitFilter,
	resolveUncategorizedCategoryId,
	type TransactionFilter,
	type TransactionSplitFilter
} from './where';
import {
	collectTransactionsMatchingQuery,
	isValidRegexQuery,
	parseQueryMode,
	type QueryMode
} from './search';

/** Every list filter, parsed and validated. Echoed back to the client by `load`. */
export interface ListFilters {
	query: string;
	qMode: QueryMode;
	type: TransactionFilter;
	category: string;
	/** The RAW `from`/`to`, trimmed — not the parsed range. The "Du"/"Au" inputs must keep showing
	 * what the user typed when the pair is incomplete or invalid, instead of clearing on error. */
	fromParam: string;
	toParam: string;
	importBatchId: string;
	tagId: string;
	/** `null` = no id filter. `[]` = MATCH NOTHING. The two are not interchangeable — see below. */
	ids: string[] | null;
	split: TransactionSplitFilter;
}

/**
 * Why the two refusal reasons are INDEPENDENT BOOLEANS rather than one discriminant.
 *
 * A URL can be wrong in both ways at once (`?from=2026-99-99&q=[&qMode=regex`), and /transactions
 * renders a different state for each: the SearchBar gets `error={Boolean(data.queryError)}` plus its
 * own "expression régulière invalide" message, while the date range renders its own. The
 * pre-refactor `load` computed the two flags independently, so both could be true together.
 *
 * The first version of this resolver returned a single `reason: 'range' | 'regex'`, checked the
 * range first and returned immediately — so with both wrong the user silently lost the regex half of
 * the feedback. That shipped past the golden master because the LIST is empty either way, so every
 * id-based comparison stayed byte-identical; it was caught by a reviewer reading the diff. The
 * golden now captures both flags for that reason.
 *
 * Callers that can only render ONE message (`bulkTag`, the CSV export) pick range first, which is
 * what both did before this refactor.
 */
export interface InvalidReasons {
	range: boolean;
	regex: boolean;
}

/**
 * The resolved scope of "which transactions match the current filter", for /transactions.
 *
 * WHY THIS IS A UNION AND NOT `{ filters, where, error }`
 *
 * The flat shape is what every external source on this refactoring recommends, and it is what this
 * chantier's own earlier investigation proposed — so a future reader WILL find support for
 * flattening it. Do not. Those sources assume the predicate is COMPLETE, and here it is not: `q` is
 * matched in JS AFTER the SQL query, because accent folding and regex cannot be pushed into SQL. A
 * caller that stops at the `where` therefore targets a STRICT SUPERSET of what the user is looking
 * at.
 *
 * That is not hypothetical. `bulkTag` shipped exactly that bug: the screen said 12 transactions and
 * the action tagged the whole year, and with an invalid regex the screen showed zero rows while the
 * action would have tagged everything. Afterwards it was guarded only by a comment on the parser —
 * which is the same protection as none, one refactor later.
 *
 * So the property that IS the complete answer exists only on the branch where the SQL predicate is
 * the complete answer:
 *
 *   - `sql`     — no search is active. `where` is the whole answer.
 *   - `scan`    — a search is active. There is no `where`; the predicate is named
 *                 `whereBeforeQuery`, because that is what it is, and the only complete answer is
 *                 `collect()`.
 *   - `invalid` — no predicate AT ALL, so a caller that ignores the discriminant cannot fall
 *                 through to an unscoped query; it fails to compile.
 *
 * If you flatten this, restore the guard some other way and prove it with the ids-empty and
 * skipped-q break-the-checks in scope.db-smoke.ts.
 *
 * SECURITY. `userId` is applied inside `buildTransactionWhere` and is the only thing between `?ids=`
 * — raw client input naming rows directly — and a cross-user read. Every branch here that exposes a
 * predicate carries it; the branch that does not expose one carries nothing to query with.
 */
export type TransactionScope =
	| { kind: 'invalid'; reasons: InvalidReasons; filters: ListFilters }
	| {
			kind: 'sql';
			filters: ListFilters;
			where: Prisma.TransactionWhereInput;
			/** The same scope with the tag conjunct omitted, for the per-tag counts. BUILT, not
			 * destructured off `where` — see the note at the call site. */
			whereWithoutTag: Prisma.TransactionWhereInput;
			/** The same scope with the split conjunct omitted. BUILT, same reason as whereWithoutTag
			 * above — see the note at the call site. */
			whereWithoutSplit: Prisma.TransactionWhereInput;
	  }
	| {
			kind: 'scan';
			filters: ListFilters;
			query: string;
			qMode: QueryMode;
			/** NOT the answer. The JS search step has not been applied to it yet. */
			whereBeforeQuery: Prisma.TransactionWhereInput;
			whereWithoutTagBeforeQuery: Prisma.TransactionWhereInput;
			whereWithoutSplitBeforeQuery: Prisma.TransactionWhereInput;
			/** The only complete answer on this branch: the predicate AND the JS search, together. */
			collect<S extends Prisma.TransactionSelect & { label: true }>(
				select: S,
				options?: { tagFree?: boolean }
			): Promise<Array<TransactionPayload<S>>>;
	  };

/**
 * Reads every list filter out of `url` and resolves it to a scope.
 *
 * Validation happens BEFORE any predicate is built, so an unusable filter can never produce a
 * half-formed `where` that a caller might still run.
 *
 * @param options.uncategorizedCategoryId lets `load` pass the id it already resolves inside its own
 * `Promise.all` (it needs the same value for the global "à classer" pile), so routing the load
 * through here costs no extra query. `undefined` means "not supplied, resolve it if needed"; `null`
 * is a real resolved value meaning the sentinel category does not exist, which
 * `buildTransactionWhere` reads as match-nothing for the classify branch.
 */
export async function resolveTransactionScope(
	userId: string,
	url: URL,
	options: { uncategorizedCategoryId?: string | null } = {}
): Promise<TransactionScope> {
	const fromParam = url.searchParams.get('from');
	const toParam = url.searchParams.get('to');
	const { range, error: rangeError } = parseTransactionDateRange(fromParam, toParam);

	const filters: ListFilters = {
		query: normalizeSearch(url.searchParams.get('q')),
		qMode: parseQueryMode(url.searchParams.get('qMode')),
		type: parseTransactionFilter(url.searchParams.get('type')),
		category: normalizeSearch(url.searchParams.get('category')),
		fromParam: (fromParam ?? '').trim(),
		toParam: (toParam ?? '').trim(),
		importBatchId: normalizeId(url.searchParams.get('importBatch')),
		tagId: normalizeId(url.searchParams.get('tag')),
		ids: normalizeIdList(url.searchParams.get('ids')),
		split: parseTransactionSplitFilter(url.searchParams.get('split'))
	};

	// Both computed, never short-circuited: see InvalidReasons. Returning on the first failure is
	// what dropped the regex feedback when a URL was wrong in both ways.
	const regexError =
		Boolean(filters.query) && filters.qMode === 'regex' && !isValidRegexQuery(filters.query);
	if (rangeError || regexError) {
		return { kind: 'invalid', reasons: { range: rangeError, regex: regexError }, filters };
	}

	const uncategorizedCategoryId =
		options.uncategorizedCategoryId !== undefined
			? options.uncategorizedCategoryId
			: filters.type === 'classify'
				? await resolveUncategorizedCategoryId(userId)
				: undefined;

	const common = {
		userId,
		type: filters.type,
		category: filters.category,
		from: range?.from,
		to: range?.to,
		importBatchId: filters.importBatchId,
		uncategorizedCategoryId,
		ids: filters.ids,
		split: filters.split
	};

	const where = buildTransactionWhere({ ...common, tagId: filters.tagId });
	// BUILT by asking the builder for a scope without the tag, never `const { tags, ...rest } = where`.
	// The rest-spread only works while the tag conjunct happens to sit at the top level; the moment a
	// future filter moves it into `AND`/`OR` the spread silently stops removing it, and
	// countTagsInScope then returns the tautology it exists to prevent — one for the selected tag, 0
	// for every other — with nothing going red. Both `load` and counts.ts carried paragraph-long
	// comments warning about exactly that. Building it cannot drift.
	const whereWithoutTag = buildTransactionWhere(common);
	// Same reasoning as whereWithoutTag above, applied to the split conjunct: BUILT with `split: 'all'`
	// overriding `common`, never destructured off `where`, for the identical reason — `where.splits`
	// does not sit at a fixed top-level shape once the classify pile is also active (see where.ts's
	// splitsRequirements accumulator).
	const whereWithoutSplit = buildTransactionWhere({
		...common,
		split: 'all',
		tagId: filters.tagId
	});

	if (!filters.query) return { kind: 'sql', filters, where, whereWithoutTag, whereWithoutSplit };

	return {
		kind: 'scan',
		filters,
		query: filters.query,
		qMode: filters.qMode,
		whereBeforeQuery: where,
		whereWithoutTagBeforeQuery: whereWithoutTag,
		whereWithoutSplitBeforeQuery: whereWithoutSplit,
		collect<S extends Prisma.TransactionSelect & { label: true }>(
			select: S,
			collectOptions?: { tagFree?: boolean }
		) {
			return collectTransactionsMatchingQuery(
				collectOptions?.tagFree ? whereWithoutTag : where,
				select,
				filters.query,
				filters.qMode
			);
		}
	};
}
