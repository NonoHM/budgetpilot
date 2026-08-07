import { isHttpError } from '@sveltejs/kit';
import type { Prisma } from '../database/types.ts';
import { parseCustomDateRange } from '$lib/server/date-range';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { prisma } from '$lib/server/db';

export type TransactionFilter = 'all' | 'income' | 'expense' | 'classify';

/** The Répartition filter dimension. `'all'` is the absence of the filter, not a third state. */
export type TransactionSplitFilter = 'all' | 'split' | 'unsplit';

export function parseTransactionSplitFilter(value: string | null): TransactionSplitFilter {
	return value === 'split' || value === 'unsplit' ? value : 'all';
}

/**
 * Resolves the userId-scoped id of the "Non catégorisé" (UNCLASSIFIED_CATEGORY) category row.
 * Backed by the unique (userId, nameKey) index — a fast point lookup, not a scan, and at most
 * one row. Used so the "to classify" pile can be filtered by categoryId equality in SQL
 * instead of a name join.
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
	/**
	 * Explicit id whitelist, from `?ids=` (see normalizeIdList). `undefined`/`null` means "no id
	 * filter"; an EMPTY array means "match nothing" and must never be allowed to collapse back into
	 * "no filter" — a list whose every element was malformed would otherwise silently widen from a
	 * handful of rows to the user's whole history.
	 */
	ids?: readonly string[] | null;
	/**
	 * Tag id from `?tag=`, already shape-checked by normalizeId.
	 *
	 * A plain conjunct, deliberately NOT one of the OR-shaped `conditions` below. Those exist only
	 * for the effective-category fallback (manualCategory ?? category.name), where one concept has
	 * two possible columns; a tag has no such split identity. Pushing it into `conditions` would
	 * make the tag WIDEN the match rather than narrow it as soon as a second condition was active.
	 *
	 * No enumeration is possible through this. `where.userId` is always present, so a tag id
	 * belonging to another account matches zero rows, byte-identical to an id that never existed.
	 */
	tagId?: string;
	/**
	 * Répartition dimension from `?split=`. A plain conjunct like `tagId`, not one of the OR-shaped
	 * `conditions`.
	 *
	 * It constrains the SAME relation as the classify pile below, which is why neither assigns
	 * `where.splits` directly: the second assignment would silently replace the first, and the
	 * combination that matters — `type=classify&split=split` — would come back as "every répartie
	 * transaction" instead of "none", with nothing going red. They are composed through
	 * `splitsRequirement` instead, and the contradictory pair resolves to match-nothing.
	 */
	split?: TransactionSplitFilter;
}): Prisma.TransactionWhereInput {
	// The one conjunct every other filter here relies on. `?ids=` in particular is raw client input
	// naming rows directly, so this equality is the whole thing standing between it and a
	// cross-user read: `id: { in: [...] }` alone would happily return another account's rows.
	const where: Prisma.TransactionWhereInput = { userId: input.userId };
	// Effective-category equality (manualCategory ?? category.name) can produce two OR-shaped
	// conditions (classify pile, category text filter) that must be ANDed together, not
	// overwrite one another — combined via `AND` below instead of both writing `where.OR`.
	const conditions: Prisma.TransactionWhereInput[] = [];
	// 'none' = must have no parts, 'some' = must have at least one, null = unconstrained. Two
	// requirements that disagree are a contradiction, resolved below as match-nothing rather than
	// as whichever was written last.
	const splitsRequirements: Array<'none' | 'some'> = [];

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
		// A répartie transaction is fully categorised by the sum invariant — every cent of it sits
		// under a part's category, and a part can never carry the sentinel — so its PARENT category
		// says nothing about whether the money needs classifying. Leaving it in the pile would ask
		// the user to classify money that is already classified, and "classify all" would then
		// overwrite the répartition to answer a question that was not open.
		//
		// A conjunct on `where`, never a third branch of `conditions`: those exist solely for the
		// effective-category fallback, where one concept has two possible columns (see the tagId
		// note above). Pushed in there it would WIDEN the pile to every unsplit transaction the
		// moment a second condition became active.
		//
		// It is also why the remainder is not consulted: a drifted parent (amount moved out from
		// under its parts) would leave real money under the sentinel, but that state is unreachable
		// — `amountCents` is never rewritten on an existing row (amount-immutability.spec.ts) and
		// the backup validator refuses a payload whose parts do not sum. If either of those two
		// facts stops holding, this line is one of the places that has to be revisited.
		//
		// `?split=` constrains the SAME relation, so this is a REQUIREMENT rather than an assignment
		// (see the `split` input's docstring). Assigning `where.splits` here and again below would
		// have put répartie rows back into the classify pile with nothing going red.
		splitsRequirements.push('none');
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
				},
				// OD-1: a transaction whose PART carries the category matches too. A widening, which is
				// the safe direction — no row that matched before stops matching.
				//
				// The parent branches above are kept rather than replaced, deliberately. A répartie
				// row filed under Maison is still filed under Maison: that is an identity fact, and
				// `?category=` reads identity as well as money. It contributes ZERO to the filtered
				// total in that case, which `computeFilteredTotals` gets right by summing allocations
				// rather than by narrowing this predicate — the list and the total answer two different
				// questions and must not be collapsed into one.
				//
				// `userId` on the part's category as well as on the parent, because the two foreign
				// keys are independent: nothing in the schema ties Category.userId to
				// Transaction.userId, so only this conjunct keeps a part's category inside the account.
				// Same rule, same reason, as the `tag: { userId }` note in tags/counts.ts.
				{
					splits: {
						some: {
							category: {
								is: { userId: input.userId, nameKey: computeNameKey(input.category) }
							}
						}
					}
				}
			]
		});
	}
	if (input.importBatchId) where.importBatchId = input.importBatchId;
	if (input.tagId) where.tags = { some: { tagId: input.tagId } };
	if (input.split === 'split') splitsRequirements.push('some');
	else if (input.split === 'unsplit') splitsRequirements.push('none');

	if (splitsRequirements.includes('none') && splitsRequirements.includes('some')) {
		// `type=classify&split=split` asks for transactions that both have and have not got parts.
		// An empty result is the honest answer; silently dropping one half would answer a question
		// the user did not ask, and it is the WIDENING half a naive last-write-wins would keep. Same
		// reasoning as `ids: []` meaning match-nothing rather than no filter.
		//
		// Expressed inside the relation filter rather than as `where.id = { in: [] }`, which would be
		// overwritten by the `?ids=` conjunct three lines down — the exact collision this whole
		// accumulator exists to avoid, reintroduced one field over. Prisma ANDs `none` and `some`, so
		// no row can satisfy both.
		where.splits = { none: {}, some: {} };
	} else if (splitsRequirements.length > 0) {
		where.splits = splitsRequirements[0] === 'none' ? { none: {} } : { some: {} };
	}
	// `input.ids` is spread into a mutable array because Prisma's generated `in` takes `string[]`;
	// the `!= null` test (not truthiness) is what keeps an empty list meaning "match nothing".
	if (input.ids != null) where.id = { in: [...input.ids] };
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

/**
 * Shape check for every id arriving as a query parameter (`selected`, `importBatch`, and each
 * element of `ids`). Returns '' for anything that is not one, which every caller reads as "absent".
 *
 * The UPPER bound is 64 and is load-bearing, not decoration: without it a single segment could be
 * arbitrarily long and the only limit was Node's `maxHeaderSize`. `?ids=` amplifies that by
 * MAX_TRANSACTION_ID_FILTER, since 250 such segments can be sent in one URL. 64 clears a cuid (25)
 * and a uuid v4/v7 (36) with room, so no id this app can generate is affected.
 *
 * The `i` flag stays. Dropping it would silently invalidate any existing link whose id contains an
 * uppercase character, which is a behaviour change, not a tightening.
 */
export function normalizeId(value: string | null): string {
	const normalized = (value ?? '').trim();
	return /^[a-z0-9_-]{8,64}$/i.test(normalized) ? normalized : '';
}

/**
 * Hard cap on how many ids `?ids=` may put inside an `IN (...)` clause.
 *
 * 250 is `MAX_ANCHOR_IDS` (backup/schema.ts), the domain's own cap on the anchor ids a recurring
 * stream stores, and the only producer of this parameter — "Voir les transactions liées" on
 * /upcoming-bills — emits exactly those anchors. So no legitimate link can reach the cap, and any
 * list that does is hand-written. It is not imported from the backup schema on purpose: this layer
 * owes the query planner a bounded `IN`, which is a property of this layer, not a fact about
 * anchors. `where.spec.ts` asserts the two stay compatible so the link cannot start being
 * truncated by a change over there.
 */
export const MAX_TRANSACTION_ID_FILTER = 250;

/**
 * Parses the `?ids=` whitelist: a comma-separated list of transaction ids.
 *
 * Three properties this is built for, in the order they matter:
 *  - BOUNDED IN COUNT BEFORE ANYTHING ELSE. `split`'s limit argument stops at
 *    `MAX_TRANSACTION_ID_FILTER` segments, so a URL carrying thousands of them never materializes
 *    thousands of strings and never reaches Prisma. Over-long lists are truncated, not rejected:
 *    truncating degrades to "fewer rows shown", which is the same direction every other cap in
 *    this feature degrades in, and it needs no new user-facing string.
 *  - Each element is shape-checked by `normalizeId`, the same validator the `selected`/`importBatch`
 *    params already go through. Anything else is dropped silently — malformed input yields a clean
 *    empty result, never a 500.
 *  - Absent (`null`) and present-but-empty are DIFFERENT. Absent returns `null` ("no filter");
 *    `?ids=` or `?ids=%20,,` returns `[]`, which `buildTransactionWhere` turns into "match nothing".
 *
 * De-duplicated so a repeated id cannot inflate the `IN` list past the cap's intent.
 */
export function normalizeIdList(value: string | null): string[] | null {
	if (value === null) return null;
	const ids = new Set<string>();
	for (const segment of value.split(',', MAX_TRANSACTION_ID_FILTER)) {
		const id = normalizeId(segment);
		if (id) ids.add(id);
	}
	return [...ids];
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
