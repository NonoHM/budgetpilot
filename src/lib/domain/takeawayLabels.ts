import * as m from '$lib/paraglide/messages';
import type { Takeaway } from '$lib/server/reports/monthly';
import { categoryDisplayName } from '$lib/domain/categoryLabels';

/**
 * Translated label for a report takeaway.
 *
 * The display function used to be INJECTED rather than imported, and the docstring said why:
 * resolving a category's label needed the current user's categories, because the label came from
 * a `defaultKey` that only a loaded row carried. Since #162 the label is a pure function of the
 * name, so the parameter was threading a constant down from the page for no reason.
 */
export function takeawayText(takeaway: Takeaway): string {
	switch (takeaway.code) {
		case 'balance_positive':
			return m.reports_takeaway_balance_positive();
		case 'balance_negative':
			return m.reports_takeaway_balance_negative();
		case 'top_category':
			return m.reports_takeaway_top_category({
				category: categoryDisplayName(takeaway.category ?? ''),
				percent: takeaway.percent ?? ''
			});
		case 'recurring':
			return m.reports_takeaway_recurring({ count: takeaway.count ?? 0 });
		case 'investment':
			return m.reports_takeaway_investment();
		case 'no_expense':
			return m.reports_takeaway_no_expense();
		case 'expense_increasing':
			return m.reports_takeaway_expense_increasing();
		case 'expense_decreasing':
			return m.reports_takeaway_expense_decreasing();
	}
}

/**
 * Dot color associated with a takeaway, derived from the stable `code` (never from
 * the displayed text): a category named "Investissement" in top_category position
 * must never take on the color of the "investment share" takeaway (code 'investment').
 */
export function takeawayDot(code: Takeaway['code']): string {
	if (code === 'balance_positive' || code === 'expense_decreasing') return 'bg-emerald-600';
	if (code === 'balance_negative' || code === 'expense_increasing') return 'bg-rose-600';
	if (code === 'investment') return 'bg-indigo-600';
	return 'bg-zinc-400';
}
