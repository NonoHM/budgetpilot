import * as m from '$lib/paraglide/messages';
import { summarizeBudgetAllocations, type MonthlyBudgetSummary } from '$lib/domain/budget';
import type { CategoryAllocation } from '$lib/domain/allocation';
import type { Transaction } from '$lib/domain/transaction';
import { readDashboardData, readDashboardDataForRange } from '$lib/server/budget/dashboard';
import { getPreviousMonthRange, type DateRange } from '$lib/server/date-range';

export interface DashboardPeriodData {
	transactions: Transaction[];
	allocations: CategoryAllocation[];
	budgets: Awaited<ReturnType<typeof readDashboardDataForRange>>['budgets'];
	summary: MonthlyBudgetSummary;
	previousSummary: MonthlyBudgetSummary | undefined;
	budgetSummaryAvailable: boolean;
}

/**
 * The period's figures as the dashboard shows them, and as the AI advice is built from them (#535).
 * ONE definition for the dashboard `load` and `POST /insights/advice`: the advice's cache key is
 * computed by the first and its prompt by the second, so two readings that drifted apart would key
 * one payload and send another.
 */
export async function readDashboardPeriodData(
	userId: string,
	period: DateRange
): Promise<DashboardPeriodData> {
	const { transactions, allocations, budgets } = await readDashboardDataForRange(userId, period);
	const budgetSummaryAvailable = isWholeMonthPeriod(period.from, period.to);
	const previousPeriod = getPreviousMonthRange(period);
	const previousMonthData = previousPeriod
		? await readDashboardData(userId, previousPeriod.budgetMonth)
		: undefined;
	const summary = summarizeBudgetAllocations(
		allocations,
		budgetSummaryAvailable ? budgets : [],
		period.label
	);
	const previousSummary =
		previousMonthData &&
		(previousMonthData.transactions.length > 0 || previousMonthData.budgets.length > 0)
			? summarizeBudgetAllocations(
					previousMonthData.allocations,
					previousMonthData.budgets,
					previousPeriod?.label ?? m.dashboard_previous_period_fallback()
				)
			: undefined;
	return { transactions, allocations, budgets, summary, previousSummary, budgetSummaryAvailable };
}

function isWholeMonthPeriod(from: Date, to: Date): boolean {
	const nextMonthStart = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
	return (
		from.getUTCDate() === 1 &&
		to.getUTCDate() === 1 &&
		to.getUTCFullYear() === nextMonthStart.getUTCFullYear() &&
		to.getUTCMonth() === nextMonthStart.getUTCMonth()
	);
}
