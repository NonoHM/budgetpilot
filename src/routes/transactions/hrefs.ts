/**
 * The one URL builder for /transactions.
 *
 * It replaces five near-identical functions that each re-listed every filter parameter
 * (buildFocusHref, buildFilterHref, buildPageHref, buildSelectedHref, buildExportHref). Adding a
 * filter used to mean six edits; it now means one. That matters beyond tidiness: the split
 * transactions and bank reconciliation chantiers both add filters to this page.
 *
 * The `keepIds` flag is NOT a simplification of the old behaviour, it is the old behaviour made
 * explicit. Paging, row selection and the export carry `?ids=` forward because all three stay
 * inside the id-filtered view. Filter changes and focus mode deliberately drop it: those are
 * navigations that visibly change the list, so the user sees they left "the transactions linked to
 * this bill" behind. The export is on the carrying side despite showing no list, because a
 * download the user cannot inspect turning into their whole history is the worse failure.
 */
export interface TransactionFilters {
	q: string;
	qMode: string;
	type: string;
	category: string;
	from: string;
	to: string;
	importBatchId: string;
	ids: string;
	tag: string;
}

function baseParams(filters: TransactionFilters, keepIds: boolean): URLSearchParams {
	// Local scratch value, built and discarded within this function; never stored as reactive state.
	// (This is a plain .ts module, so svelte/prefer-svelte-reactivity does not fire here at all.)
	const params = new URLSearchParams();
	if (filters.q) params.set('q', filters.q);
	if (filters.q && filters.qMode === 'regex') params.set('qMode', 'regex');
	if (filters.category) params.set('category', filters.category);
	if (filters.from) params.set('from', filters.from);
	if (filters.to) params.set('to', filters.to);
	if (filters.importBatchId) params.set('importBatch', filters.importBatchId);
	// Carried by paging, selection and the export, like every other filter here. It is NOT on the
	// keepIds side of the split: a tag filter is an ordinary narrowing of the list, not a
	// "these specific rows" view the user needs to be shown leaving.
	if (filters.tag) params.set('tag', filters.tag);
	if (keepIds && filters.ids) params.set('ids', filters.ids);
	return params;
}

/**
 * The filter params a `<form method="GET">` must carry as hidden inputs to survive a native submit.
 *
 * Derived from the same TransactionFilters shape baseParams uses, so a new filter param is added
 * ONCE. Before this existed the two filter forms on /transactions carried hidden inputs for only
 * `type` and `importBatch`. Measured in a browser on 2026-08-04, both surfaces: starting from
 * `/transactions?q=a&category=Alimentation&from=2026-01-01&to=2026-12-31`, clicking the search
 * field and pressing Enter navigated to `?qMode=contains&q=ab` — category and period silently
 * dropped, and the triggers fell back to their resting labels. `tag` drops by the same mechanism.
 *
 * `q` and `qMode` are deliberately absent from this list: they are real named controls already
 * inside those forms (a `SearchBar name="q"` and a hand-written hidden `qMode` input), and
 * emitting them again here would submit two values for one key.
 *
 * `ids` is ALSO deliberately absent, and this is design, not the bug this function fixes: a search
 * is a filter change, and `applyFilterDimension` (routes/transactions/+page.svelte) already calls
 * `buildTransactionsHref(..., { keepIds: false })` for exactly this reason — changing the category,
 * the tag or the period drops `ids` while preserving every other dimension, so a user who arrived
 * via an id-scoped link (e.g. "these transactions linked to this bill") sees they left that view
 * once they narrow the list further. `keepIds: false` here makes the two GET forms agree with that
 * existing rule instead of inventing a second one. Pinned from the other side by
 * `ids-filter-links.svelte.spec.ts`'s "carries no ids hidden input in the search forms" case — do
 * not flip this to `true` to "restore" ids, that would reverse a decision this function is not the
 * one to make.
 */
export function filterHiddenInputs(
	filters: TransactionFilters
): Array<{ name: string; value: string }> {
	const params = baseParams(filters, false);
	params.delete('q');
	params.delete('qMode');
	if (filters.type !== 'all') params.set('type', filters.type);
	return [...params].map(([name, value]) => ({ name, value }));
}

export function buildTransactionsHref(
	filters: TransactionFilters,
	overrides: Partial<Record<'type' | 'page' | 'selected', string>>,
	options: { keepIds: boolean }
): `/transactions?${string}` {
	const params = baseParams(filters, options.keepIds);

	// An override replaces the ambient filter; 'all' is the default and is never emitted, whichever
	// of the two supplied it. That single rule reproduces all five original builders exactly:
	// buildFocusHref forced 'classify', buildFilterHref keyed off the DESTINATION tab, and
	// buildPageHref / buildSelectedHref / buildExportHref carried the ambient value forward. Each
	// emitted `type` only when the value it was working with was not 'all'.
	//
	// Do not "simplify" this back to `overrides.type !== undefined ? set(override) : ...`. That
	// shape makes an absent override mean "keep ambient", so the "Toutes" tab, which asks for
	// 'all', silently re-emits the filter it is meant to clear and becomes a dead link on exactly
	// the pages where it matters. A test pins both halves.
	const effectiveType = overrides.type ?? filters.type;
	if (effectiveType !== 'all') params.set('type', effectiveType);

	if (overrides.page !== undefined) params.set('page', overrides.page);
	if (overrides.selected !== undefined) params.set('selected', overrides.selected);

	return `/transactions?${params.toString()}` as `/transactions?${string}`;
}

export function buildTransactionsExportHref(filters: TransactionFilters): string {
	const params = baseParams(filters, true);
	if (filters.type !== 'all') params.set('type', filters.type);
	return `/transactions/export?${params.toString()}`;
}
