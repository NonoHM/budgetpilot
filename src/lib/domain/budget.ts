import type { CategoryAllocation } from './allocation';
import { normalizeForMatch } from './normalize';
import {formatMoney, money, DEFAULT_CURRENCY } from './money';
import { getLocale } from '$lib/paraglide/runtime';
import * as m from '$lib/paraglide/messages';

export interface CategoryBudget {
	category: string;
	limitCents: number;
}

export interface CategoryBudgetSummary {
	category: string;
	limitCents: number;
	spentCents: number;
	remainingCents: number;
	usagePercentage: number;
	status: 'ok' | 'near_limit' | 'over_budget';
	isOverBudget: boolean;
}

export interface MonthlyBudgetSummary {
	month: string;
	incomeCents: number;
	expenseCents: number;
	balanceCents: number;
	categorySummaries: CategoryBudgetSummary[];
}

export function summarizeMonthlyBudget(
	allocations: CategoryAllocation[],
	budgets: CategoryBudget[],
	month: string
): MonthlyBudgetSummary {
	return summarizeBudgetAllocations(
		allocations.filter((allocation) => allocation.date.startsWith(`${month}-`)),
		budgets,
		month
	);
}

/**
 * The budget summary, over ALLOCATIONS only — it asks nothing an allocation cannot answer.
 *
 * Renamed from `summarizeBudgetTransactions` rather than merely retyped, so that every call site
 * has to be looked at rather than silently keeping a name that now describes the wrong view. A
 * budget is a claim about where money went; attributing a split purchase entirely to its parent
 * category is the exact figure this function must not produce.
 *
 * `incomeCents` / `expenseCents` are unchanged in value: every allocation carries its transaction's
 * kind, so summing them per kind equals summing the transactions per kind.
 */
export function summarizeBudgetAllocations(
	allocations: CategoryAllocation[],
	budgets: CategoryBudget[],
	period: string
): MonthlyBudgetSummary {
	const incomeCents = allocations
		.filter((allocation) => allocation.kind === 'income')
		.reduce((total, allocation) => total + Math.abs(allocation.amountCents), 0);
	const expenseCents = allocations
		.filter((allocation) => allocation.kind === 'expense')
		.reduce((total, allocation) => total + Math.abs(allocation.amountCents), 0);
	// Spend is accumulated per folded category name, not per raw one: "Courses" and
	// "courses" are one category everywhere else in the app, so they have to be one line in
	// the budget too. See domain/normalize.ts.
	const spentByCategory = new Map<string, number>();
	const budgetCategories = new Set(budgets.map((budget) => normalizeForMatch(budget.category)));
	for (const allocation of allocations) {
		if (!shouldCountAllocationForBudget(allocation, budgetCategories)) continue;
		const key = normalizeForMatch(allocation.category);
		spentByCategory.set(key, (spentByCategory.get(key) ?? 0) + Math.abs(allocation.amountCents));
	}

	const categorySummaries = budgets.map((budget) => {
		const spentCents = spentByCategory.get(normalizeForMatch(budget.category)) ?? 0;
		const remainingCents = budget.limitCents - spentCents;
		const status: CategoryBudgetSummary['status'] =
			remainingCents < 0
				? 'over_budget'
				: spentCents >= budget.limitCents * 0.8
					? 'near_limit'
					: 'ok';

		return {
			category: budget.category,
			limitCents: budget.limitCents,
			spentCents,
			remainingCents,
			usagePercentage:
				budget.limitCents > 0 ? Math.round((spentCents / budget.limitCents) * 100) : 0,
			status,
			isOverBudget: remainingCents < 0
		};
	});

	return {
		month: period,
		incomeCents,
		expenseCents,
		balanceCents: incomeCents - expenseCents,
		categorySummaries
	};
}

/**
 * `budgetCategories` holds folded names (see the call site), so the lookup folds too.
 *
 * The old transaction-shaped version ended `|| !transaction.nature`, treating an unresolved nature
 * as spending. An allocation's `nature` is required, so that clause has no counterpart and none is
 * needed: every boundary resolves a nature before building one, and an expense with no mapping
 * resolves to 'spending' — the same answer the fallback gave, reached by the rule rather than by
 * the absence of one.
 */
function shouldCountAllocationForBudget(
	allocation: CategoryAllocation,
	budgetCategories: Set<string>
): boolean {
	if (allocation.kind !== 'expense') return false;
	if (budgetCategories.has(normalizeForMatch(allocation.category))) return true;

	return allocation.nature === 'spending' || allocation.nature === 'fee';
}

export type BudgetDeltaTone = 'positive' | 'warning' | 'danger';

export interface BudgetDelta {
	status: CategoryBudgetSummary['status'];
	tone: BudgetDeltaTone;
	text: string;
}

export function formatBudgetDelta(spentCents: number, limitCents: number): BudgetDelta {
	const remainingCents = limitCents - spentCents;
	const status: CategoryBudgetSummary['status'] =
		remainingCents < 0 ? 'over_budget' : spentCents >= limitCents * 0.8 ? 'near_limit' : 'ok';
	const tone: BudgetDeltaTone =
		status === 'over_budget' ? 'danger' : status === 'near_limit' ? 'warning' : 'positive';
	const text =
		remainingCents < 0
			? m.budget_delta_over({ amount: formatCents(-remainingCents) })
			: m.budget_delta_remaining({ amount: formatCents(remainingCents) });

	return { status, tone, text };
}

export function formatSpentOfLimit(spentCents: number, limitCents: number): string {
	return `${formatCents(spentCents)} / ${formatCents(limitCents)}`;
}

export function formatCents(
	amountCents: number,
	locale = getLocale(),
	currency = DEFAULT_CURRENCY,
	/**
	 * Passed straight to `Intl.NumberFormat`. Default `'auto'` is the existing behaviour: a minus on
	 * negatives, nothing on positives.
	 *
	 * `'exceptZero'` exists for the transactions summary band, where the design shows both figures
	 * signed ("Dépenses -3 418,90 €   Revenus +4 260,00 €"). Concatenating a "+" instead would put
	 * one sign in the app's hands and the other in Intl's, and Intl decides both the glyph and which
	 * side of the number it goes on per locale. (Measured, because it is easy to assume otherwise:
	 * `fr` emits U+002D here, not the typographic U+2212 — so "which glyph" is not a thing to guess
	 * at in either direction.)
	 */
	signDisplay: Intl.NumberFormatOptions['signDisplay'] = 'auto'
): string {
	return formatMoney(money(amountCents, currency), { locale, signDisplay });
}
