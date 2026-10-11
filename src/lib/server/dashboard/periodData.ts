import { summarizeBudgetAllocations, type MonthlyBudgetSummary } from '$lib/domain/budget';
import type { CategoryAllocation } from '$lib/domain/allocation';
import type { Transaction } from '$lib/domain/transaction';
import { readDashboardDataForRange } from '$lib/server/budget/dashboard';
import type { DateRange } from '$lib/server/date-range';

export interface DashboardPeriodData {
	transactions: Transaction[];
	allocations: CategoryAllocation[];
	budgets: Awaited<ReturnType<typeof readDashboardDataForRange>>['budgets'];
	summary: MonthlyBudgetSummary;
	budgetSummaryAvailable: boolean;
}

/**
 * The period's figures as the dashboard shows them. Extracted for the AI advice (#535), which read
 * the same figures from a second route plus the previous month's; the advice and that extra read
 * left in #1010, and the dashboard `load` is the one reader now.
 */
export async function readDashboardPeriodData(
	userId: string,
	period: DateRange
): Promise<DashboardPeriodData> {
	const { transactions, allocations, budgets } = await readDashboardDataForRange(userId, period);
	const budgetSummaryAvailable = isWholeMonthPeriod(period.from, period.to);
	const summary = summarizeBudgetAllocations(
		allocations,
		budgetSummaryAvailable ? budgets : [],
		period.label
	);
	return { transactions, allocations, budgets, summary, budgetSummaryAvailable };
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
