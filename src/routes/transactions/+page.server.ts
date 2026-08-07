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
	getEffectiveTransactionNature,
	EFFECTIVE_CATEGORY_SELECT,
	type SplitRow
} from '$lib/server/transactions/nature';
import {
	buildTransactionWhere,
	normalizeId,
	normalizeIdList,
	resolveUncategorizedCategoryId
} from '$lib/server/transactions/where';
import { resolveTransactionScope } from '$lib/server/transactions/scope';
import { isSplitTransaction } from '$lib/server/transactions/splits';
import { countSplitsInScope, userHasAnySplit } from '$lib/server/transactions/splitCounts';
import type { Prisma } from '$lib/server/database/types';
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

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	const page = parsePositiveInteger(url.searchParams.get('page')) ?? 1;
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

	// Resolved BEFORE the scope, because it can change what the scope is.
	//
	// The Répartition control is not rendered until at least one répartition exists. The design's
	// own answer for the moment the last one is removed: "s'il était actif il est d'abord retiré, la
	// ligne de résumé revenant au total complet". Without this the user keeps an ACTIVE filter with
	// no control to clear it — invisible, un-removable except by editing the URL, and narrowing the
	// list to nothing. So the parameter is dropped from the URL the scope is built from, which also
	// makes every href built from `filters` come back clean.
	const splitFilterAvailable = await userHasAnySplit(user.id);
	const scopeUrl = new URL(url);
	if (!splitFilterAvailable) scopeUrl.searchParams.delete('split');

	// Passes `uncategorizedCategoryId` in rather than letting the resolver look it up itself: it is
	// already fetched above (the "à classer" pile needs the same value), so routing the load through
	// the shared resolver costs no extra query.
	const scope = await resolveTransactionScope(user.id, scopeUrl, { uncategorizedCategoryId });
	const { filters } = scope;

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
	if (selectedTransaction && filters.type === 'classify') {
		const selCat = getEffectiveCategory(selectedTransaction);
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

	// Spreads EFFECTIVE_CATEGORY_SELECT rather than naming `manualCategory` and `category` by hand,
	// which is what this list did before: `sumFilteredTotals` now answers a per-category question on
	// the `?q=` path, so this read joined the family of money reads the fragment exists to keep in
	// agreement. Naming the columns here again would have made a fourth copy, and forgetting `splits`
	// would have silently reported a répartie row's whole total under the filtered category.
	const transactionSelect = {
		id: true,
		date: true,
		label: true,
		amountCents: true,
		type: true,
		source: true,
		natureManual: true,
		...EFFECTIVE_CATEGORY_SELECT,
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
		splits: SplitRow[];
		tags: TagLinkRow[];
	}

	const queryError = scope.kind === 'invalid' && scope.reasons.regex;
	const dateRangeError = scope.kind === 'invalid' && scope.reasons.range;

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
	let matchedRows: TransactionListRow[] | null = null;
	// The one place the "does this filter carry a category dimension" question is asked, so the two
	// totals paths cannot disagree about it. Empty string means no dimension, never "the category
	// whose name is empty".
	const categoryTotalsScope = filters.category
		? { userId: user.id, name: filters.category }
		: undefined;
	if (scope.kind === 'invalid') {
		totalTransactions = 0;
		totalPages = 1;
		safePage = 1;
		transactions = [];
		filteredTotals = { incomeCents: 0, expenseCents: 0 };
	} else if (scope.kind === 'sql') {
		totalTransactions = await prisma.transaction.count({ where: scope.where });
		// One extra count, and only when a tag filter is actually on. Without one the two scopes are
		// the same set by construction, so asking twice would buy nothing.
		tagScopeTotal = filters.tagId
			? await prisma.transaction.count({ where: scope.whereWithoutTag })
			: totalTransactions;
		totalPages = Math.max(1, Math.ceil(totalTransactions / PAGE_SIZE));
		safePage = Math.min(page, totalPages);
		transactions = await prisma.transaction.findMany({
			where: scope.where,
			select: transactionSelect,
			// The `id` tiebreak is load-bearing, not decoration. `date` alone is not a total order —
			// a bank import routinely lands a whole day's transactions on one date — and with
			// `skip`/`take` the engine is free to order tied rows differently per query. Two adjacent
			// pages are two queries, so a row could appear on both, or on neither: a user paginating
			// could simply never see a transaction they own, with nothing anywhere reporting it.
			//
			// `forEachTransactionBatch` (the `?q=` scan path) and `classifyStackRows` already order by
			// both columns; this was the one paged read that did not, so the list and the scan
			// disagreed about what "the next page" means.
			orderBy: [{ date: 'desc' }, { id: 'desc' }],
			skip: (safePage - 1) * PAGE_SIZE,
			take: PAGE_SIZE
		});
		// Alongside the count, over the same `where`: the total describes the filtered SET, which
		// is why it is not derived from `transactions` (that is one page of it).
		filteredTotals = await computeFilteredTotals(scope.where, categoryTotalsScope);
	} else {
		// The scan runs ONCE, on the tag-free scope, and the tag filter is applied to its result in
		// JS. Scanning the tag-filtered scope instead and reusing its ids for the counts is what
		// produced the tautology described at `matchedIds`; scanning twice would be the same rows
		// read twice. The predicate mirrors `tags: { some: { tagId } }` exactly — `transactionSelect`
		// already carries each row's tag links, so nothing extra is fetched to evaluate it.
		const filteredAll = await scope.collect(transactionSelect, { tagFree: true });
		tagScopeTotal = filteredAll.length;
		const filtered = filters.tagId
			? filteredAll.filter((row) => row.tags.some((link) => link.tag.id === filters.tagId))
			: filteredAll;
		totalTransactions = filtered.length;
		totalPages = Math.max(1, Math.ceil(totalTransactions / PAGE_SIZE));
		safePage = Math.min(page, totalPages);
		transactions = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
		// The q path matches in JS, so the SQL aggregate would not see the same set. Same numbers,
		// different source; totals.spec.ts pins the two implementations against one fixture.
		filteredTotals = sumFilteredTotals(filtered, filters.category || undefined);
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
	// Gated on the DISCRIMINANT, not on the two derived booleans. `queryError`/`dateRangeError` are
	// a re-derivation of `scope.kind === 'invalid'`, and using them for control flow is what forced
	// the `!` assertions this block used to carry — silencing the compiler on exactly the guarantee
	// `scope.ts` promises it enforces. The equivalence held only while `invalid` meant precisely
	// `range || regex`; a third refusal reason would have made both booleans false on an `invalid`
	// scope, and this block would have queried with `undefined`.
	if (
		scope.kind !== 'invalid' &&
		totalTransactions > MAX_BULK_TAG_TRANSACTIONS &&
		filters.type === 'all'
	) {
		const kinds: TransactionKind[] = ['expense', 'income'];
		const candidates = matchedRows
			? kinds.map((kind) => ({
					kind,
					count: matchedRows.filter((row) => resolveTransactionType(row) === kind).length
				}))
			: // `matchedRows` is only set on the `scan` branch, so this arm is the `sql` one — but the
				// predicate is read off the narrowed scope rather than asserted, so it stays total.
				await Promise.all(
					kinds.map(async (kind) => ({
						kind,
						count: await prisma.transaction.count({
							where: {
								AND: [
									scope.kind === 'sql' ? scope.where : scope.whereBeforeQuery,
									transactionKindWhere(kind)
								]
							}
						})
					}))
				);
		bulkFallback =
			candidates
				.filter((c) => c.count > 0 && c.count <= MAX_BULK_TAG_TRANSACTIONS)
				.sort((a, b) => b.count - a.count)[0] ?? null;
	}

	let tagCounts: TagScopeCount[] | null = null;
	// Same reason as the block above: narrowed on `scope.kind`, so the tag-free predicate is read
	// off the scope instead of being asserted non-undefined.
	if (scope.kind !== 'invalid') {
		try {
			// `q` is matched in JS AFTER the SQL query (accent folding and regex are not expressible
			// in SQL — see `scope.ts`'s own docstring). Counting over the raw `where` while a
			// search is active would count a STRICT SUPERSET of what the user is looking at, so when
			// `matchedIds` was set above, the count is narrowed to exactly that id set instead.
			// The id list is passed separately rather than folded into the where: unbounded, it
			// becomes one `IN (...)` as long as the whole matched set, and SQLite caps host
			// parameters — so a user with enough transactions and a broad enough search silently
			// and permanently got "comptes indisponibles" via the catch below, with no trace
			// anywhere. countTagsInScope chunks it and sums.
			tagCounts = await countTagsInScope(
				user.id,
				scope.kind === 'sql' ? scope.whereWithoutTag : scope.whereWithoutTagBeforeQuery,
				matchedIds
			);
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

	// The per-option counts, a question about the current SCOPE — distinct from
	// `splitFilterAvailable` above, which is user-wide and decides whether the control exists at
	// all. Inferring one from the other is what would make the control vanish the moment a filter
	// narrowed to rows that happen to carry no parts: "un filtre qui s'évapore pendant qu'on
	// l'utilise est pire que le filtre inutile qu'on cherchait à éviter".
	const splitCounts =
		scope.kind === 'invalid'
			? null
			: await countSplitsInScope(
					user.id,
					scope.kind === 'sql' ? scope.whereWithoutSplit : scope.whereWithoutSplitBeforeQuery,
					matchedIds
				).catch((error) => {
					// Best-effort, exactly like tagCounts above, and the name only for the same reason:
					// a Prisma error on a transaction query embeds parameter values, which here means
					// labels and amounts.
					console.warn(
						'splitCounts unavailable:',
						error instanceof Error ? error.name : 'unknown error'
					);
					return null;
				});

	return {
		splitFilterAvailable,
		splitCounts,
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
			q: filters.query,
			qMode: filters.qMode,
			type: filters.type,
			category: filters.category,
			from: filters.fromParam,
			to: filters.toParam,
			importBatchId: filters.importBatchId,
			// Re-serialized from the PARSED list, never echoed from the raw param: what the page
			// carries forward through pagination is exactly what the query ran on.
			//
			// This DELIBERATELY collapses the absent-vs-empty distinction the load itself preserves
			// (`null` = no filter, `[]` = match nothing) into one `''`. Sound only because `[]`
			// returns zero rows, and with zero rows there is no pagination control and no row link
			// to carry anything forward — the two cases have no observable difference here. A
			// future consumer of `filters.ids` that runs when the list is empty must not assume it.
			ids: filters.ids ? filters.ids.join(',') : '',
			tag: filters.tagId,
			split: filters.split
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
		// Consumed by PeriodFilter's presets ("Ce mois-ci", "12 derniers mois"...): the component must
		// never read the wall clock itself, or its boundaries stop being testable at a pinned date.
		todayIso: new Date().toISOString().slice(0, 10),
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
	 * The set is rebuilt here from `url.searchParams`, through the same `resolveTransactionScope`
	 * the load uses, and the form's own fields are never consulted for it. A client-supplied id list
	 * would make the count the user confirmed and the set actually written two different things,
	 * which is exactly the gap a forged payload would widen.
	 *
	 * The SQL where is not the whole set, though. See the `scan` branch below: the search filter
	 * lives in JS, so reproducing the user's view means reproducing that step too — see `scope.ts`'s
	 * own docstring for why the union shape is what prevents this from silently regressing again.
	 */
	bulkTag: async ({ locals, request, url }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();

		const tagName = normalizeTagName(getFormValue(formData, 'tagName'));
		if (!tagName) return fail(400, { bulkTagError: m.tags_bulk_error_empty_name() });

		const scope = await resolveTransactionScope(user.id, url);
		if (scope.kind === 'invalid')
			return fail(400, {
				bulkTagError: scope.reasons.range
					? m.tags_bulk_error_invalid_range()
					: m.transactions_error_invalid_regex_query()
			});

		let where: Prisma.TransactionWhereInput;
		if (scope.kind === 'sql') {
			where = scope.where;
		} else {
			const matching = await scope.collect({ id: true, label: true });
			// Refused here rather than inside applyTagToFilteredSet, because that function counts in
			// SQL and this set does not exist in SQL. Same limit, same refusal, one message.
			if (matching.length > MAX_BULK_TAG_TRANSACTIONS)
				return fail(400, {
					bulkTagError: m.tags_bulk_error_too_many({
						count: matching.length,
						limit: MAX_BULK_TAG_TRANSACTIONS
					})
				});
			// Narrowing, never widening: `matching` was collected THROUGH the scope's predicate, so it
			// is already the intersection with every other active filter, `?ids=` included.
			where = { ...scope.whereBeforeQuery, id: { in: matching.map((row) => row.id) } };
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

		// `splits: { none: {} }` is the protection, not the check below it: the parent's category is
		// frozen while the transaction is répartie (D1), and an aria-disabled selector is a statement
		// about a DOM node, not about a request. Atomic, so a split landing between the two queries
		// cannot slip through.
		const result = await prisma.transaction.updateMany({
			where: { id: transactionId, userId: user.id, splits: { none: {} } },
			data: manualCategoryUpdate(categoryResult.value)
		});

		if (result.count === 0) {
			if (await isSplitTransaction(user.id, transactionId))
				return fail(400, { manualCategoryError: m.transactions_error_category_locked_by_split() });
			return fail(404, { manualCategoryError: m.transactions_error_transaction_not_found() });
		}
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

		// Same guard, same reason as saveManualCategory. Reachable even though the suggestion is only
		// offered inside the classify pile — which no longer contains répartie rows — because a focus
		// session holds its stack for its whole lifetime while another tab can split a row inside it.
		const result = await prisma.transaction.updateMany({
			where: { id: transactionId, userId: user.id, splits: { none: {} } },
			data: {
				...manualCategoryUpdate(categoryResult.value),
				natureManual: natureResult.value
			}
		});
		if (result.count === 0) {
			if (await isSplitTransaction(user.id, transactionId))
				return fail(400, { acceptError: m.transactions_error_category_locked_by_split() });
			return fail(404, { acceptError: m.transactions_error_transaction_not_found() });
		}
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
			// `splits: { none: {} }` here and on the write below. The stack was frozen when focus mode
			// opened, so a row in it may have been répartie since — and a rule silently overwriting the
			// parent's category would contradict D1 on a transaction the user never named.
			where: {
				userId: user.id,
				id: { in: focusRemainingIds },
				manualCategory: null,
				splits: { none: {} }
			},
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
				where: {
					id: { in: autoAppliedIds },
					userId: user.id,
					manualCategory: null,
					splits: { none: {} }
				},
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
