import { fail, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import {
	TRANSACTION_NATURES,
	type TransactionKind,
	type TransactionNature,
	isTransactionNature
} from '$lib/domain/transaction';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { manualCategoryUpdate } from '$lib/server/transactions/manualCategory';
import { setTransactionTags } from '$lib/server/tags/service';
import { countTagsInScope, type TagScopeCount } from '$lib/server/tags/counts';
import {
	applyTagToFilteredSet,
	undoBulkTag,
	MAX_BULK_TAG_TRANSACTIONS
} from '$lib/server/tags/bulk';
import { MAX_TAGS_PER_TRANSACTION, normalizeTagName } from '$lib/domain/tags';
import {
	findMatchingCategoryRule,
	applyCategoryRules,
	parseCategoryRuleInput
} from '$lib/server/categorization/rules';
import {
	buildCategoryNatureMap,
	getEffectiveCategory,
	getEffectiveTransactionNature
} from '$lib/server/transactions/nature';
import {
	buildTransactionWhere,
	normalizeId,
	normalizeIdList,
	normalizeSearch,
	parseTransactionDateRange,
	parseTransactionFilter,
	resolveUncategorizedCategoryId
} from '$lib/server/transactions/where';
import {
	collectTransactionsMatchingQuery,
	isValidRegexQuery,
	parseQueryMode
} from '$lib/server/transactions/search';
import {
	anonymizeDetailText,
	anonymizeReference,
	truncateText
} from '$lib/server/transactions/anonymize';
import {
	computeFilteredTotals,
	sumFilteredTotals,
	resolveTransactionType,
	transactionKindWhere,
	type FilteredTotals
} from '$lib/server/transactions/totals';
import type { PageServerLoad } from './$types';

/** The join row Prisma returns for the `tags` relation, before flattenTagLinks unwraps it. */
interface TagLinkRow {
	tag: { id: string; name: string; colorToken: string };
}

const PAGE_SIZE = 25;
const MAX_MANUAL_CATEGORY_LENGTH = 60;
const MAX_MANUAL_NATURE_LENGTH = 32;
// Defensive cap on the Focus mode stack (see forEachTransactionBatch/rawForClassify removal in
// CLAUDE.md technical debt): ids only, so memory cost is negligible even at the cap, but an
// unbounded findMany on a pathological "everything uncategorized" history is still avoided.
const FOCUS_STACK_CAP = 5000;

/**
 * Parses every list filter out of the URL.
 *
 * Extracted so `load` and the bulk actions read the SAME parameters through the SAME validators.
 * That is not tidiness: the count a user confirms in the bulk dialog and the set the action then
 * writes to must come from one source, or a forged payload could widen the second past the first.
 * The bulk action deliberately accepts no id list of its own for that reason.
 *
 * Reading these params is NOT sufficient on its own, and a review caught this comment claiming it
 * was. `query`/`qMode` never enter `buildTransactionWhere`: both `load` and `bulkTag` apply them in
 * JS afterwards, so a caller that stops at the `where` silently targets a superset. Any future
 * consumer of this function has to handle the search filter explicitly, the way `bulkTag` does.
 */
function parseListFilters(url: URL) {
	const fromParam = url.searchParams.get('from');
	const toParam = url.searchParams.get('to');
	return {
		query: normalizeSearch(url.searchParams.get('q')),
		qMode: parseQueryMode(url.searchParams.get('qMode')),
		type: parseTransactionFilter(url.searchParams.get('type')),
		category: normalizeSearch(url.searchParams.get('category')),
		fromParam,
		toParam,
		...parseTransactionDateRange(fromParam, toParam),
		importBatchId: normalizeId(url.searchParams.get('importBatch')),
		tagId: normalizeId(url.searchParams.get('tag')),
		// Explicit id whitelist. Deliberately NOT applied to `uncategorizedPileWhere`: the
		// "à classer" pile is global by design (see its comment), not a view of the current filters.
		ids: normalizeIdList(url.searchParams.get('ids'))
	};
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	const page = parsePositiveInteger(url.searchParams.get('page')) ?? 1;
	const {
		query,
		qMode,
		type,
		category,
		fromParam,
		toParam,
		range: dateRange,
		error: dateRangeError,
		importBatchId,
		tagId,
		ids
	} = parseListFilters(url);
	// Raw values (not dateRange.fromDate/toDate) so the "Du"/"Au" inputs keep showing exactly
	// what the user typed when the pair is incomplete/invalid, instead of clearing on error.
	const fromDisplay = (fromParam ?? '').trim();
	const toDisplay = (toParam ?? '').trim();
	const selectedId = normalizeId(url.searchParams.get('selected'));

	const [categories, mappings, selectedTransaction, rules, uncategorizedCategoryId, allTags] =
		await Promise.all([
			prisma.category.findMany({
				where: { userId: user.id },
				orderBy: { name: 'asc' },
				select: { name: true, defaultKey: true }
			}),
			prisma.categoryNatureMapping.findMany({
				where: { userId: user.id },
				orderBy: { categoryName: 'asc' },
				select: { categoryName: true, nature: true }
			}),
			selectedId
				? prisma.transaction.findFirst({
						where: { id: selectedId, userId: user.id },
						select: {
							id: true,
							date: true,
							label: true,
							amountCents: true,
							type: true,
							source: true,
							notes: true,
							bankOperationType: true,
							manualCategory: true,
							natureManual: true,
							dedupeKey: true,
							metadataJson: true,
							createdAt: true,
							updatedAt: true,
							category: { select: { name: true } },
							account: {
								select: {
									name: true,
									source: true,
									netWorthAccount: { select: { name: true } }
								}
							},
							importBatch: {
								select: { id: true, fileName: true, source: true, rowCount: true, createdAt: true }
							},
							tags: { select: { tag: { select: { id: true, name: true, colorToken: true } } } }
						}
					})
				: Promise.resolve(null),
			prisma.categoryRule.findMany({
				where: { userId: user.id, enabled: true },
				orderBy: { createdAt: 'asc' },
				select: {
					id: true,
					name: true,
					matchText: true,
					targetCategory: true,
					targetNature: true,
					isRegex: true,
					enabled: true
				}
			}),
			resolveUncategorizedCategoryId(user.id),
			// The whole tag list, not a page of it: MAX_TAGS_PER_TRANSACTION bounds what one
			// transaction carries, and a user's total tag count is small by construction because a
			// tag with no transactions is pruned the moment it loses its last one.
			prisma.tag.findMany({
				where: { userId: user.id },
				orderBy: { name: 'asc' },
				select: { id: true, name: true, colorToken: true }
			})
		]);

	const mappingMap = buildCategoryNatureMap(mappings);

	// "To classify" pile: independent of the current tab/filters (see classifyStackIds comment
	// below) — always the global uncategorized-by-category set, computed in SQL instead of
	// scanning every transaction into memory (see CLAUDE.md technical debt on rawForClassify).
	const uncategorizedPileWhere = buildTransactionWhere({
		userId: user.id,
		type: 'classify',
		category: '',
		importBatchId: '',
		uncategorizedCategoryId
	});

	const [uncategorizedCount, classifyStackRows] = await Promise.all([
		prisma.transaction.count({ where: uncategorizedPileWhere }),
		prisma.transaction.findMany({
			where: uncategorizedPileWhere,
			select: { id: true, label: true, manualCategory: true },
			orderBy: [{ date: 'desc' }, { id: 'desc' }],
			take: FOCUS_STACK_CAP
		})
	]);
	const classifyStackIds = classifyStackRows.map((t) => t.id);
	// Matching needs JS (accent-insensitive/regex), so it can't be pushed into SQL — but it's
	// scoped to the already-fetched, FOCUS_STACK_CAP-bounded stack (not a separate unbounded scan
	// over the whole pile): the "accept all" button only ever acts on that same stack anyway.
	const classifiableCount = classifyStackRows.filter(
		(row) =>
			findMatchingCategoryRule({ label: row.label, manualCategory: row.manualCategory }, rules) !==
			null
	).length;

	let selectedSuggestion: {
		category: string;
		nature: TransactionNature | null;
		source: 'rule';
	} | null = null;
	if (selectedTransaction && type === 'classify') {
		const selCat = selectedTransaction.manualCategory ?? selectedTransaction.category.name;
		const selNat = getEffectiveTransactionNature(
			{
				amountCents: selectedTransaction.amountCents,
				type: resolveTransactionType(selectedTransaction),
				category: selCat,
				natureManual: selectedTransaction.natureManual
			},
			mappingMap
		);
		if (selNat.nature === 'uncategorized') {
			selectedSuggestion = computeSuggestion(
				{ label: selectedTransaction.label, manualCategory: selectedTransaction.manualCategory },
				rules,
				mappingMap
			);
		}
	}

	const where = buildTransactionWhere({
		userId: user.id,
		type,
		category,
		from: dateRange?.from,
		to: dateRange?.to,
		importBatchId,
		uncategorizedCategoryId,
		ids,
		tagId
	});

	const transactionSelect = {
		id: true,
		date: true,
		label: true,
		amountCents: true,
		type: true,
		source: true,
		manualCategory: true,
		natureManual: true,
		category: { select: { name: true } },
		tags: { select: { tag: { select: { id: true, name: true, colorToken: true } } } }
	} as const;

	interface TransactionListRow {
		id: string;
		date: Date;
		label: string;
		amountCents: number;
		type: string | null;
		source: string;
		manualCategory: string | null;
		natureManual: TransactionNature | null;
		category: { name: string };
		tags: TagLinkRow[];
	}

	const queryError = Boolean(query) && qMode === 'regex' && !isValidRegexQuery(query);

	let totalTransactions: number;
	let safePage: number;
	let totalPages: number;
	let transactions: TransactionListRow[];
	let filteredTotals: FilteredTotals;
	// Set only on the `q` branch below, to the ids the JS match admitted **on the tag-free scope**.
	// Reused for the tag counts rather than re-running the match: see the comment at `tagCounts`.
	//
	// Tag-free is load-bearing and was wrong once. Taking the ids from the tag-FILTERED match put
	// the tag conjunct back into the count as `id: { in: … }`, undoing the strip below through the
	// most ordinary filter on the page: with `?tag=A&q=foo`, every other tag's count became
	// |A ∩ B ∩ q| instead of |B ∩ q|, so any tag that does not co-occur with A read 0 — and the
	// filter panel makes a zero-count option unselectable. The count added to prevent a filter that
	// returns nothing was instead forbidding filters that return plenty.
	let matchedIds: string[] | null = null;
	// The size of that same tag-free scope, for the dropdown's "Toutes" row. It is NOT
	// `totalTransactions`, which is the tag-FILTERED total: with `?tag=Portugal` active, that would
	// have "Toutes" claim the same figure as "Portugal", i.e. that clearing the filter changes
	// nothing. Equal to it, and computed without a second query, whenever no tag filter is active.
	let tagScopeTotal = 0;
	// The whole filtered set, in memory, on the `?q=` branch only — the branch that already has it.
	// Used for the bulk fallback below, so that branch needs no extra query at all.
	let matchedRows: Array<{ amountCents: number; type: string | null }> | null = null;

	// The tag dimension is removed on purpose: counting inside its own filter would report 1 for
	// the selected tag and 0 for every other, which is not a comparison, it is a tautology.
	//
	// This works only because `buildTransactionWhere` puts the tag filter at the TOP LEVEL as
	// `where.tags`. If a future filter moves it into `AND`/`OR`, this rest-spread silently stops
	// removing it. `page.server.spec.ts` pins it with a fixture where two different tags sit on two
	// different transactions, which is the minimum shape in which the tautology is visible.
	const { tags: tagConjunct, ...tagCountWhere } = where;

	if (queryError || dateRangeError) {
		totalTransactions = 0;
		totalPages = 1;
		safePage = 1;
		transactions = [];
		filteredTotals = { incomeCents: 0, expenseCents: 0 };
	} else if (!query) {
		totalTransactions = await prisma.transaction.count({ where });
		// One extra count, and only when a tag filter is actually on. Without one the two scopes are
		// the same set by construction, so asking twice would buy nothing.
		tagScopeTotal = tagConjunct
			? await prisma.transaction.count({ where: tagCountWhere })
			: totalTransactions;
		totalPages = Math.max(1, Math.ceil(totalTransactions / PAGE_SIZE));
		safePage = Math.min(page, totalPages);
		transactions = await prisma.transaction.findMany({
			where,
			select: transactionSelect,
			orderBy: { date: 'desc' },
			skip: (safePage - 1) * PAGE_SIZE,
			take: PAGE_SIZE
		});
		// Alongside the count, over the same `where`: the total describes the filtered SET, which
		// is why it is not derived from `transactions` (that is one page of it).
		filteredTotals = await computeFilteredTotals(where);
	} else {
		// The scan runs ONCE, on the tag-free scope, and the tag filter is applied to its result in
		// JS. Scanning the tag-filtered scope instead and reusing its ids for the counts is what
		// produced the tautology described at `matchedIds`; scanning twice would be the same rows
		// read twice. The predicate mirrors `tags: { some: { tagId } }` exactly — `transactionSelect`
		// already carries each row's tag links, so nothing extra is fetched to evaluate it.
		const filteredAll = await collectTransactionsMatchingQuery(
			tagCountWhere,
			transactionSelect,
			query,
			qMode
		);
		tagScopeTotal = filteredAll.length;
		const filtered = tagId
			? filteredAll.filter((row) => row.tags.some((link) => link.tag.id === tagId))
			: filteredAll;
		totalTransactions = filtered.length;
		totalPages = Math.max(1, Math.ceil(totalTransactions / PAGE_SIZE));
		safePage = Math.min(page, totalPages);
		transactions = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
		// The q path matches in JS, so the SQL aggregate would not see the same set. Same numbers,
		// different source; totals.spec.ts pins the two implementations against one fixture.
		filteredTotals = sumFilteredTotals(filtered);
		matchedIds = filteredAll.map((row) => row.id);
		matchedRows = filtered;
	}

	/**
	 * A narrowing the user could apply that WOULD fit under the bulk cap, with its real count.
	 *
	 * Offered only when the bulk action would refuse — over `MAX_BULK_TAG_TRANSACTIONS` — and only
	 * when the nature tab is still "Toutes", since that is the dimension being proposed. If neither
	 * half lands under the cap the answer is `null` and the banner offers NOTHING: proposing a route
	 * that cannot help is the /upcoming-bills defect closed in #99, and re-creating it here would be
	 * worse, because this one names a number the user can check.
	 *
	 * The dimension is income-vs-expense rather than the category, because that one is exact in SQL:
	 * `transactionKindWhere` is the proven twin of `resolveTransactionType` (totals.db-smoke.ts
	 * asserts they agree over the whole type x sign matrix, on all three engines). The effective
	 * CATEGORY is computed in JS from manual overrides and rules, so a SQL groupBy on `categoryId`
	 * would count something the user is not looking at.
	 *
	 * The larger of the two viable halves is chosen: it is the most inclusive narrowing that still
	 * passes, so the user is asked to give up as little as possible.
	 */
	let bulkFallback: { kind: TransactionKind; count: number } | null = null;
	if (
		!queryError &&
		!dateRangeError &&
		totalTransactions > MAX_BULK_TAG_TRANSACTIONS &&
		type === 'all'
	) {
		const kinds: TransactionKind[] = ['expense', 'income'];
		const candidates = matchedRows
			? kinds.map((kind) => ({
					kind,
					count: matchedRows.filter((row) => resolveTransactionType(row) === kind).length
				}))
			: await Promise.all(
					kinds.map(async (kind) => ({
						kind,
						count: await prisma.transaction.count({
							where: { AND: [where, transactionKindWhere(kind)] }
						})
					}))
				);
		bulkFallback =
			candidates
				.filter((c) => c.count > 0 && c.count <= MAX_BULK_TAG_TRANSACTIONS)
				.sort((a, b) => b.count - a.count)[0] ?? null;
	}

	let tagCounts: TagScopeCount[] | null = null;
	if (!queryError && !dateRangeError) {
		try {
			// `q` is matched in JS AFTER the SQL query (accent folding and regex are not expressible
			// in SQL — see parseListFilters' own comment). Counting over the raw `where` while a
			// search is active would count a STRICT SUPERSET of what the user is looking at, so when
			// `matchedIds` was set above, the count is narrowed to exactly that id set instead.
			// The id list is passed separately rather than folded into the where: unbounded, it
			// becomes one `IN (...)` as long as the whole matched set, and SQLite caps host
			// parameters — so a user with enough transactions and a broad enough search silently
			// and permanently got "comptes indisponibles" via the catch below, with no trace
			// anywhere. countTagsInScope chunks it and sums.
			tagCounts = await countTagsInScope(user.id, tagCountWhere, matchedIds);
		} catch (error) {
			// Best-effort enrichment: a failure here must never fail the page. The filter panel
			// renders its own "comptes indisponibles" state from a null tagCounts.
			//
			// The error's NAME only, never the error. A Prisma error on a transaction query embeds
			// parameter values, which here means labels and amounts — the banking data this project
			// does not put in logs. Logged at all because the bare catch that preceded this made a
			// systematic failure (an engine limit, a migration drift, a provider-specific groupBy
			// incompatibility) indistinguishable from a transient one, and left no evidence.
			console.warn('tagCounts unavailable:', error instanceof Error ? error.name : 'unknown error');
			tagCounts = null;
		}
	}

	return {
		transactions: transactions.map((t) => mapTransactionListItem(t, mappingMap, rules)),
		selectedTransaction: selectedTransaction
			? mapTransactionDetail(selectedTransaction, mappingMap)
			: null,
		selectedSuggestion,
		categoryOptions: buildCategoryOptions(categories),
		categories,
		allTags,
		natureOptions: TRANSACTION_NATURES,
		filters: {
			q: query,
			qMode,
			type,
			category,
			from: fromDisplay,
			to: toDisplay,
			importBatchId,
			// Re-serialized from the PARSED list, never echoed from the raw param: what the page
			// carries forward through pagination is exactly what the query ran on.
			//
			// This DELIBERATELY collapses the absent-vs-empty distinction the load itself preserves
			// (`null` = no filter, `[]` = match nothing) into one `''`. Sound only because `[]`
			// returns zero rows, and with zero rows there is no pagination control and no row link
			// to carry anything forward — the two cases have no observable difference here. A
			// future consumer of `filters.ids` that runs when the list is empty must not assume it.
			ids: ids ? ids.join(',') : '',
			tag: tagId
		},
		filteredTotals,
		tagCounts,
		// How many transactions the current filter matches with the tag dimension REMOVED — the
		// figure the "Toutes" row of the tag dropdown reports. Deliberately outside `pagination`,
		// which describes the list actually being paged and must keep describing exactly that.
		tagScopeTotal,
		bulkFallback,
		queryError,
		dateRangeError,
		pagination: {
			page: safePage,
			pageSize: PAGE_SIZE,
			totalTransactions,
			totalPages,
			hasPrevious: safePage > 1,
			hasNext: safePage < totalPages
		},
		uncategorizedCount,
		classifiableCount,
		// Always exposed (not gated by `type === 'classify'` like `selectedSuggestion`): the
		// "Mode focus" button lives in the banner shown on every tab, so it needs the full stack
		// to jump to the first uncategorized id regardless of the tab the user is currently on.
		classifyStackIds
	};
};

function computeSuggestion(
	transaction: { label: string; manualCategory: string | null },
	rules: Array<{
		id?: string;
		name: string;
		matchText: string;
		targetCategory: string;
		targetNature?: TransactionNature | null;
		enabled: boolean;
	}>,
	mappingMap: Map<string, TransactionNature>
): { category: string; nature: TransactionNature | null; source: 'rule' } | null {
	const matched = findMatchingCategoryRule(transaction, rules);
	if (!matched) return null;
	const cat = matched.targetCategory;
	const nature = matched.targetNature ?? mappingMap.get(cat) ?? null;
	return { category: cat, nature, source: 'rule' };
}

function buildCategoryOptions(categories: Array<{ name: string }>): string[] {
	return categories.map((c) => c.name).sort((left, right) => left.localeCompare(right, 'fr'));
}

export const actions: Actions = {
	/**
	 * Applies one tag to every transaction the CURRENT FILTERS match.
	 *
	 * The set is rebuilt here from `url.searchParams`, through the same parseListFilters the load
	 * uses, and the form's own fields are never consulted for it. A client-supplied id list would
	 * make the count the user confirmed and the set actually written two different things, which is
	 * exactly the gap a forged payload would widen.
	 *
	 * The SQL where is not the whole set, though, and the first version of this comment claimed it
	 * was. See the `filters.query` branch below: the search filter lives in JS, so reproducing the
	 * user's view means reproducing that step too.
	 */
	bulkTag: async ({ locals, request, url }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();

		const tagName = normalizeTagName(getFormValue(formData, 'tagName'));
		if (!tagName) return fail(400, { bulkTagError: m.tags_bulk_error_empty_name() });

		const filters = parseListFilters(url);
		if (filters.error) return fail(400, { bulkTagError: m.tags_bulk_error_invalid_range() });

		const uncategorizedCategoryId =
			filters.type === 'classify' ? await resolveUncategorizedCategoryId(user.id) : undefined;

		let where = buildTransactionWhere({
			userId: user.id,
			type: filters.type,
			category: filters.category,
			from: filters.range?.from,
			to: filters.range?.to,
			importBatchId: filters.importBatchId,
			uncategorizedCategoryId,
			ids: filters.ids,
			tagId: filters.tagId
		});

		// The search filter cannot live in the `where`, and that is the whole reason this branch
		// exists. `q` is matched in JS AFTER the SQL query (accent folding and regex are not
		// expressible in SQL), exactly as `load` does it below. An action that built only the SQL
		// where would apply the tag to a STRICT SUPERSET of the rows the user was looking at and
		// counted, which is the same disagreement a forged id list would create, reached through the
		// app's own most-used filter instead of through an attack.
		if (filters.query) {
			if (filters.qMode === 'regex' && !isValidRegexQuery(filters.query))
				return fail(400, { bulkTagError: m.transactions_error_invalid_regex_query() });

			const matching = await collectTransactionsMatchingQuery(
				where,
				{ id: true, label: true },
				filters.query,
				filters.qMode
			);
			// Refused here rather than inside applyTagToFilteredSet, because that function counts in
			// SQL and this set does not exist in SQL. Same limit, same refusal, one message.
			if (matching.length > MAX_BULK_TAG_TRANSACTIONS)
				return fail(400, {
					bulkTagError: m.tags_bulk_error_too_many({
						count: matching.length,
						limit: MAX_BULK_TAG_TRANSACTIONS
					})
				});
			// Narrowing, never widening: `matching` was collected THROUGH `where`, so it is already
			// the intersection with every other active filter, `?ids=` included.
			where = { ...where, id: { in: matching.map((row) => row.id) } };
		}

		const result = await applyTagToFilteredSet(user.id, where, tagName);
		if (result.outcome === 'over-tag-cap')
			return fail(400, {
				bulkTagError: m.tags_bulk_error_over_tag_cap({
					count: result.overCapCount,
					max: MAX_TAGS_PER_TRANSACTION
				})
			});
		if (result.outcome === 'too-many')
			return fail(400, {
				bulkTagError: m.tags_bulk_error_too_many({
					count: result.matched,
					limit: MAX_BULK_TAG_TRANSACTIONS
				})
			});

		// No payload for an action that changed nothing. The empty case carries no tag id, so an undo
		// control rendered from it would submit '' and come back as "cannot undo" for an action that
		// did nothing wrong.
		if (result.linkedTransactionIds.length === 0) return { bulkTagEmpty: true };

		return {
			bulkTagResult: {
				tagId: result.tagId,
				tagName: result.tagName,
				// The count APPLIED, never the count the dialog predicted: the set can change between
				// the confirm and the submit, and a banner that reports the stale number is a false
				// claim about what just happened.
				appliedCount: result.linkedTransactionIds.length,
				transactionIds: result.linkedTransactionIds
			}
		};
	},

	undoBulkTag: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();

		const tagId = normalizeId(getFormValue(formData, 'tagId'));
		if (!tagId) return fail(400, { bulkTagError: m.tags_bulk_error_undo_failed() });

		// Same parser `?ids=` goes through, so a malformed segment is dropped rather than rejecting
		// the whole undo: a partial undo is better than none. Absent and empty both mean "nothing to
		// undo" here, which undoBulkTag treats as a no-op rather than an empty-IN delete.
		const transactionIds = normalizeIdList(getFormValue(formData, 'transactionIds')) ?? [];

		await undoBulkTag(user.id, tagId, transactionIds);
		return { undoBulkTagSuccess: true };
	},

	saveTags: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const transactionId = normalizeId(getFormValue(formData, 'transactionId'));
		if (!transactionId) return fail(400, { tagsError: m.transactions_error_invalid_transaction() });

		// Newline separated, not comma. A tag name may legitimately contain a comma ("Lisbonne,
		// Porto"), while normalizeTagName collapses every whitespace run, so a newline cannot
		// survive inside a stored name and is unambiguous as a separator.
		//
		// An empty field is a legal input meaning "remove every tag", not a validation failure. That
		// is why this filters to a possibly-empty array rather than rejecting one.
		const names = getFormValue(formData, 'tags')
			.split('\n')
			.map((entry) => entry.trim())
			.filter(Boolean);

		// Ownership is the service's job, not this action's: setTransactionTags reads the
		// transaction under (id, userId) before writing anything, and returns 'not-found' for a
		// forged id indistinguishably from one that never existed.
		const outcome = await setTransactionTags(user.id, transactionId, names);
		if (outcome === 'not-found')
			return fail(404, { tagsError: m.transactions_error_transaction_not_found() });
		if (outcome === 'too-many')
			return fail(400, { tagsError: m.tags_error_too_many({ max: MAX_TAGS_PER_TRANSACTION }) });
		return { tagsSuccess: true };
	},

	saveManualCategory: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const transactionId = normalizeId(getFormValue(formData, 'transactionId'));
		const categoryResult = parseManualCategory(getFormValue(formData, 'manualCategory'));

		if (!transactionId)
			return fail(400, { manualCategoryError: m.transactions_error_invalid_transaction() });
		if (!categoryResult.ok) return fail(400, { manualCategoryError: categoryResult.error });

		if (categoryResult.value) {
			const cat = await prisma.category.findFirst({
				where: { userId: user.id, nameKey: computeNameKey(categoryResult.value) }
			});
			if (!cat) return fail(400, { manualCategoryError: m.categories_error_invalid() });
		}

		const result = await prisma.transaction.updateMany({
			where: { id: transactionId, userId: user.id },
			data: manualCategoryUpdate(categoryResult.value)
		});

		if (result.count === 0)
			return fail(404, { manualCategoryError: m.transactions_error_transaction_not_found() });
		return { manualCategorySuccess: true };
	},

	saveManualNature: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const transactionId = normalizeId(getFormValue(formData, 'transactionId'));
		const natureResult = parseManualNature(getFormValue(formData, 'manualNature'));

		if (!transactionId)
			return fail(400, { manualNatureError: m.transactions_error_invalid_transaction() });
		if (!natureResult.ok) return fail(400, { manualNatureError: natureResult.error });

		const result = await prisma.transaction.updateMany({
			where: { id: transactionId, userId: user.id },
			data: { natureManual: natureResult.value }
		});
		if (result.count === 0)
			return fail(404, { manualNatureError: m.transactions_error_transaction_not_found() });
		return { manualNatureSuccess: true };
	},

	acceptSuggestion: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const transactionId = normalizeId(getFormValue(formData, 'transactionId'));
		const rawCategory = getFormValue(formData, 'category');
		const rawNature = getFormValue(formData, 'nature');

		if (!transactionId)
			return fail(400, { acceptError: m.transactions_error_invalid_transaction() });

		const categoryResult = parseManualCategory(rawCategory);
		if (!categoryResult.ok) return fail(400, { acceptError: categoryResult.error });
		if (!categoryResult.value)
			return fail(400, { acceptError: m.transactions_error_category_required() });

		const cat = await prisma.category.findFirst({
			where: { userId: user.id, nameKey: computeNameKey(categoryResult.value) }
		});
		if (!cat) return fail(400, { acceptError: m.categories_error_invalid() });

		const natureResult = rawNature.trim()
			? parseManualNature(rawNature)
			: { ok: true as const, value: null };
		if (!natureResult.ok) return fail(400, { acceptError: natureResult.error });

		const result = await prisma.transaction.updateMany({
			where: { id: transactionId, userId: user.id },
			data: {
				...manualCategoryUpdate(categoryResult.value),
				natureManual: natureResult.value
			}
		});
		if (result.count === 0)
			return fail(404, { acceptError: m.transactions_error_transaction_not_found() });
		return { acceptSuccess: true };
	},

	classifyAll: async ({ locals }) => {
		const user = requireUser(locals.user);
		// Scopes applyCategoryRules to the "à classer" pile directly by categoryId (its own
		// `manualCategory: null` filter already excludes the other classify-pile branch —
		// manualCategory === UNCLASSIFIED_CATEGORY — same as before this refactor) instead of
		// pre-loading every pile id into memory just to pass them back as `id: { in: [...] }`.
		const uncategorizedCategoryId = await resolveUncategorizedCategoryId(user.id);
		// Fail-closed like buildTransactionWhere's own sentinel (where.ts): an unresolved category
		// must degrade to "match nothing", never to "no categoryId filter at all" (which would
		// widen the scope to every manualCategory:null transaction, not just the pile).
		const updated = await applyCategoryRules(user.id, {
			categoryId: uncategorizedCategoryId ?? '__none__'
		});
		return { classifyAllSuccess: true, updated };
	},

	deleteTransaction: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const transactionId = normalizeId(getFormValue(formData, 'transactionId'));

		if (!transactionId)
			return fail(400, { deleteError: m.transactions_error_invalid_transaction() });

		const result = await prisma.transaction.deleteMany({
			where: { id: transactionId, userId: user.id }
		});

		if (result.count === 0)
			return fail(404, { deleteError: m.transactions_error_transaction_not_found() });
		return { deleteSuccess: true };
	},

	createRule: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const parsed = parseCategoryRuleInput({
			name: getFormValue(formData, 'name'),
			matchText: getFormValue(formData, 'matchText'),
			targetCategory: getFormValue(formData, 'targetCategory'),
			targetNature: getFormValue(formData, 'targetNature'),
			enabled: true
		});

		if (!parsed.ok) return fail(400, { createRuleError: parsed.error });

		const createdRule = await prisma.categoryRule.create({
			data: { userId: user.id, ...parsed.value }
		});

		// Focus mode (optional, see createRuleInFocusMode in +page.svelte): as soon as a rule is
		// created, it automatically classifies ALL REMAINING items in the current session's frozen
		// pile that match it — wherever they are in the pile, not just the next consecutive ones
		// (two non-contiguous matches, e.g. positions 5 and 30 out of 43, are both applied; the
		// counter can therefore jump non-contiguously). ONLY against the rule that was just created —
		// never other already-active rules (those only apply on import or via "Apply rules"/
		// classifyAll, which remain the only mechanisms touching the full history). Reuses
		// findMatchingCategoryRule as-is, no new matching logic.
		const focusRemainingIds = formData
			.getAll('focusRemainingIds')
			.map((value) => normalizeId(String(value)))
			.filter((id): id is string => id.length > 0);

		if (focusRemainingIds.length === 0) return { createRuleSuccess: true };

		const candidates = await prisma.transaction.findMany({
			where: { userId: user.id, id: { in: focusRemainingIds }, manualCategory: null },
			select: { id: true, label: true, manualCategory: true }
		});
		const candidateById = new Map(candidates.map((t) => [t.id, t]));

		const autoAppliedIds: string[] = [];
		for (const id of focusRemainingIds) {
			const candidate = candidateById.get(id);
			if (!candidate) continue;
			if (!findMatchingCategoryRule(candidate, [createdRule])) continue;
			autoAppliedIds.push(id);
		}

		if (autoAppliedIds.length > 0) {
			await prisma.transaction.updateMany({
				where: { id: { in: autoAppliedIds }, userId: user.id, manualCategory: null },
				data: {
					...manualCategoryUpdate(createdRule.targetCategory),
					...(createdRule.targetNature ? { natureManual: createdRule.targetNature } : {})
				}
			});
		}

		return { createRuleSuccess: true, autoAppliedIds };
	}
};

function mapTransactionListItem(
	transaction: {
		id: string;
		date: Date;
		label: string;
		amountCents: number;
		type: string | null;
		source: string;
		manualCategory: string | null;
		natureManual: TransactionNature | null;
		category: { name: string };
		tags: TagLinkRow[];
	},
	mappingMap: Map<string, TransactionNature>,
	rules: Array<{
		id?: string;
		name: string;
		matchText: string;
		targetCategory: string;
		targetNature?: TransactionNature | null;
		enabled: boolean;
	}>
) {
	const category = getEffectiveCategory(transaction);
	const nature = getEffectiveTransactionNature(
		{
			amountCents: transaction.amountCents,
			type: resolveTransactionType(transaction),
			category,
			natureManual: transaction.natureManual
		},
		mappingMap
	);
	const suggestion =
		nature.nature === 'uncategorized' ? computeSuggestion(transaction, rules, mappingMap) : null;

	return {
		id: transaction.id,
		date: transaction.date.toISOString().slice(0, 10),
		label: truncateText(transaction.label, 64),
		category,
		importedCategory: transaction.category.name,
		manualCategory: transaction.manualCategory,
		isManualCategory: transaction.manualCategory !== null,
		nature: nature.nature,
		natureSource: nature.source,
		manualNature: transaction.natureManual,
		amountCents: transaction.amountCents,
		type: resolveTransactionType(transaction),
		source: transaction.source,
		tags: flattenTagLinks(transaction.tags),
		suggestion
	};
}

/**
 * Unwraps the join rows Prisma returns for the `tags` relation.
 *
 * The select yields `{ tag: {...} }` wrappers because TransactionTag is an explicit model. Handing
 * that shape to the view would put the join table in the template, where a later `t.tag.name` is
 * one refactor away from a runtime error the load/view boundary hides from the type checker.
 */
function flattenTagLinks(links: TagLinkRow[]): Array<{
	id: string;
	name: string;
	colorToken: string;
}> {
	return links.map((link) => link.tag);
}

function mapTransactionDetail(
	transaction: {
		id: string;
		date: Date;
		label: string;
		amountCents: number;
		type: string | null;
		source: string;
		notes: string | null;
		bankOperationType: string | null;
		manualCategory: string | null;
		natureManual: TransactionNature | null;
		dedupeKey: string | null;
		metadataJson: string | null;
		createdAt: Date;
		updatedAt: Date;
		category: { name: string };
		account: {
			name: string;
			source: string;
			netWorthAccount: { name: string } | null;
		} | null;
		importBatch: {
			fileName: string | null;
			source: string;
			id: string;
			rowCount: number;
			createdAt: Date;
		} | null;
		tags: TagLinkRow[];
	},
	mappingMap: Map<string, TransactionNature>
) {
	const metadata = parseMetadata(transaction.metadataJson);
	const category = getEffectiveCategory(transaction);
	const nature = getEffectiveTransactionNature(
		{
			amountCents: transaction.amountCents,
			type: resolveTransactionType(transaction),
			category,
			natureManual: transaction.natureManual
		},
		mappingMap
	);

	return {
		id: transaction.id,
		date: transaction.date.toISOString().slice(0, 10),
		label: anonymizeDetailText(transaction.label),
		amountCents: transaction.amountCents,
		type: resolveTransactionType(transaction),
		category,
		importedCategory: transaction.category.name,
		manualCategory: transaction.manualCategory,
		isManualCategory: transaction.manualCategory !== null,
		nature: nature.nature,
		natureSource: nature.source,
		manualNature: transaction.natureManual,
		source: transaction.source,
		notes: transaction.notes ? anonymizeDetailText(transaction.notes) : null,
		reference: metadata.reference ? anonymizeReference(metadata.reference) : null,
		dedupeKey: transaction.dedupeKey ? anonymizeReference(transaction.dedupeKey) : null,
		createdAt: transaction.createdAt.toISOString(),
		updatedAt: transaction.updatedAt.toISOString(),
		account: transaction.account
			? {
					name: transaction.account.name,
					source: transaction.account.source,
					netWorthAccountName: transaction.account.netWorthAccount?.name ?? null
				}
			: null,
		importBatch: transaction.importBatch
			? {
					id: transaction.importBatch.id,
					fileName: transaction.importBatch.fileName,
					source: transaction.importBatch.source,
					rowCount: transaction.importBatch.rowCount,
					createdAt: transaction.importBatch.createdAt.toISOString()
				}
			: null,
		bankFields: getAllowedBankFields(metadata.csvFields),
		bankOperationType: transaction.bankOperationType,
		subcategory: metadata.subcategory,
		// Not run through anonymizeDetailText, unlike the label and the notes beside it. Those hold
		// bank-supplied text this app never authored; a tag name is the user's own word, and folding
		// it would make the editor round-trip a different string than the one they typed.
		tags: flattenTagLinks(transaction.tags)
	};
}

function parseMetadata(value: string | null): {
	reference: string;
	subcategory: string;
	csvFields: Record<string, string>;
} {
	if (!value) return { reference: '', subcategory: '', csvFields: {} };

	try {
		const parsed = JSON.parse(value) as {
			reference?: unknown;
			subcategory?: unknown;
			csvFields?: unknown;
		};

		return {
			reference: typeof parsed.reference === 'string' ? parsed.reference : '',
			subcategory: typeof parsed.subcategory === 'string' ? parsed.subcategory : '',
			csvFields:
				parsed.csvFields && typeof parsed.csvFields === 'object'
					? Object.fromEntries(
							Object.entries(parsed.csvFields).filter(
								(entry): entry is [string, string] => typeof entry[1] === 'string'
							)
						)
					: {}
		};
	} catch {
		return { reference: '', subcategory: '', csvFields: {} };
	}
}

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}

function parseManualCategory(
	value: string
): { ok: true; value: string | null } | { ok: false; error: string } {
	const normalized = value.trim().replace(/\s+/g, ' ');
	if (!normalized) return { ok: true, value: null };
	if (/[<>\p{Cc}]/u.test(normalized)) return { ok: false, error: m.categories_error_invalid() };
	if (normalized.length > MAX_MANUAL_CATEGORY_LENGTH) {
		return { ok: false, error: m.transactions_error_category_too_long() };
	}
	return { ok: true, value: normalized };
}

function parseManualNature(
	value: string
): { ok: true; value: TransactionNature | null } | { ok: false; error: string } {
	const normalized = value.trim().slice(0, MAX_MANUAL_NATURE_LENGTH);
	if (!normalized) return { ok: true, value: null };
	if (!isTransactionNature(normalized))
		return { ok: false, error: m.categories_error_invalid_nature() };
	return { ok: true, value: normalized };
}

function parsePositiveInteger(value: string | null): number | null {
	if (!value || !/^\d+$/.test(value)) return null;
	const parsed = Number(value);
	return parsed > 0 ? parsed : null;
}

function getAllowedBankFields(csvFields: Record<string, string>) {
	const allowedLabels = [
		'Libelle simplifie',
		'Libelle operation',
		'Type operation',
		'Categorie',
		'Sous categorie',
		'Informations complementaires',
		'Date de comptabilisation',
		'Date operation',
		'Date de valeur',
		'Pointage operation'
	];

	return allowedLabels
		.map((label) => ({ label, value: csvFields[label] ?? '' }))
		.filter((field) => field.value !== '')
		.map((field) => ({ label: field.label, value: anonymizeDetailText(field.value) }));
}
