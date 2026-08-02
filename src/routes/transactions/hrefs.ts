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
	if (keepIds && filters.ids) params.set('ids', filters.ids);
	return params;
}

export function buildTransactionsHref(
	filters: TransactionFilters,
	overrides: Partial<Record<'type' | 'page' | 'selected', string>>,
	options: { keepIds: boolean }
): `/transactions?${string}` {
	const params = baseParams(filters, options.keepIds);

	// An explicit override is emitted as given, including 'all'; only the ambient filter value is
	// suppressed when it is the default. Focus mode relies on this to force type=classify.
	if (overrides.type !== undefined) params.set('type', overrides.type);
	else if (filters.type !== 'all') params.set('type', filters.type);

	if (overrides.page !== undefined) params.set('page', overrides.page);
	if (overrides.selected !== undefined) params.set('selected', overrides.selected);

	return `/transactions?${params.toString()}` as `/transactions?${string}`;
}

export function buildTransactionsExportHref(filters: TransactionFilters): string {
	const params = baseParams(filters, true);
	if (filters.type !== 'all') params.set('type', filters.type);
	return `/transactions/export?${params.toString()}`;
}
