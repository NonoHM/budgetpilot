import type { CategoryBudgetSummary } from '$lib/domain/budget';
import type { Transaction } from '$lib/domain/transaction';
import type { CategoryAllocation } from '$lib/domain/allocation';
import { readDashboardData, getCurrentMonth } from '$lib/server/budget/dashboard';
import { summarizeBudgetAllocations } from '$lib/domain/budget';
import { countUncategorizedTransactions } from '$lib/server/transactions/nature';

const MAX_ALERTS = 2;
const MAX_ALERT_EXPENSES = 3;
const HISTORY_MONTHS = 3;
const MIN_HISTORY_MONTHS_WITH_DATA = 2;
const UNUSUAL_INCREASE_THRESHOLD = 0.3;
const UNUSUAL_MIN_CURRENT_CENTS = 2000;

export interface BudgetAlertExpense {
	label: string;
	date: string;
	amountCents: number;
}

export interface BudgetAlert {
	category: string;
	status: 'over_budget' | 'near_limit';
	spentCents: number;
	limitCents: number;
	remainingCents: number;
	remainingDays: number | null;
	dailyPaceCents: number | null;
	topExpenses: BudgetAlertExpense[];
}

export interface UnusualSpendingInsight {
	category: string;
	currentCents: number;
	averageCents: number;
	increasePercentage: number;
}

export interface DashboardInsights {
	alerts: BudgetAlert[];
	alertOverflowCount: number;
	unusualSpending: UnusualSpendingInsight | null;
	uncategorizedCount: number;
}

export function rankAlertedBudgets(
	categorySummaries: CategoryBudgetSummary[]
): CategoryBudgetSummary[] {
	return categorySummaries
		.filter((summary) => summary.status !== 'ok')
		.sort((a, b) => {
			if (a.status !== b.status) return a.status === 'over_budget' ? -1 : 1;
			if (a.status === 'over_budget') return a.remainingCents - b.remainingCents;
			return b.usagePercentage - a.usagePercentage;
		});
}

/**
 * Ranks the biggest contributors to a flagged budget: SELECTED BY ALLOCATION, DISPLAYED BY PARENT.
 *
 * The amount is what the category actually received; the label and date come from the transaction
 * it came out of. Showing the parent's whole 80 € under "Maison" when only 20 € was Maison is a
 * false figure on the very screen that exists to explain an overrun — but showing a bare amount
 * with no label would be useless, so the two views are read together here, deliberately.
 *
 * Parts of ONE transaction landing in the same category are summed back into one row before
 * ranking. Two parts in one category is legal, and listing the same purchase twice would read as
 * two purchases: the double-count moved from the total into the list.
 */
function rankCategoryContributors(
	allocations: CategoryAllocation[],
	labelsByTransactionId: Map<string, string>,
	category: string
): BudgetAlertExpense[] {
	const perTransaction = new Map<string, { date: string; amountCents: number }>();
	for (const allocation of allocations) {
		if (allocation.category !== category || allocation.kind !== 'expense') continue;
		const current = perTransaction.get(allocation.transactionId);
		perTransaction.set(allocation.transactionId, {
			date: allocation.date,
			amountCents: (current?.amountCents ?? 0) + allocation.amountCents
		});
	}

	return [...perTransaction.entries()]
		.map(([transactionId, entry]) => ({
			label: labelsByTransactionId.get(transactionId) ?? '',
			date: entry.date,
			amountCents: entry.amountCents
		}))
		.sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents))
		.slice(0, MAX_ALERT_EXPENSES);
}

export function computeBudgetAlerts(
	categorySummaries: CategoryBudgetSummary[],
	allocationsThisMonth: CategoryAllocation[],
	transactionsThisMonth: Transaction[],
	remainingDays: number
): { alerts: BudgetAlert[]; overflowCount: number } {
	const ranked = rankAlertedBudgets(categorySummaries);
	const shown = ranked.slice(0, MAX_ALERTS);
	const labelsByTransactionId = new Map(
		transactionsThisMonth.map((transaction) => [transaction.id, transaction.label])
	);

	const alerts = shown.map((summary) => {
		const topExpenses = rankCategoryContributors(
			allocationsThisMonth,
			labelsByTransactionId,
			summary.category
		);

		const effectiveRemainingDays = remainingDays > 0 ? remainingDays : null;
		const dailyPaceCents =
			summary.status === 'near_limit' && effectiveRemainingDays
				? Math.round(summary.remainingCents / effectiveRemainingDays)
				: null;

		return {
			category: summary.category,
			status: summary.status as 'over_budget' | 'near_limit',
			spentCents: summary.spentCents,
			limitCents: summary.limitCents,
			remainingCents: summary.remainingCents,
			remainingDays: effectiveRemainingDays,
			dailyPaceCents,
			topExpenses
		};
	});

	return { alerts, overflowCount: Math.max(0, ranked.length - MAX_ALERTS) };
}

export function computeUnusualSpendingInsight(
	currentSpendByCategory: Map<string, number>,
	historicalMonthSpends: Map<string, number>[]
): UnusualSpendingInsight | null {
	const monthsWithData = historicalMonthSpends.filter((month) => month.size > 0);
	if (monthsWithData.length < MIN_HISTORY_MONTHS_WITH_DATA) return null;

	let best: UnusualSpendingInsight | null = null;

	for (const [category, currentCents] of currentSpendByCategory) {
		if (currentCents < UNUSUAL_MIN_CURRENT_CENTS) continue;

		const averageCents =
			monthsWithData.reduce((total, month) => total + (month.get(category) ?? 0), 0) /
			monthsWithData.length;
		if (averageCents <= 0) continue;

		const increasePercentage = ((currentCents - averageCents) / averageCents) * 100;
		if (increasePercentage < UNUSUAL_INCREASE_THRESHOLD * 100) continue;

		if (!best || increasePercentage > best.increasePercentage) {
			best = { category, currentCents, averageCents, increasePercentage };
		}
	}

	return best;
}

export function getRemainingDaysInMonth(month: string): number {
	// UTC throughout, to stay consistent with getCurrentMonth(), which is what the `month` argument
	// comes from at the only call site. The two must share a basis or they disagree about which
	// month is current: with getCurrentMonth() on UTC and this on local time, at 2026-08-31 23:30
	// UTC on a UTC+2 host the caller asks for August while this function sees September, answers 0,
	// and the pace insight disappears from a month that has thirty-one days left.
	//
	// Inclusive of today, unlike domain/forecast.ts's getRemainingDaysInMonthUtc, which counts the
	// days STILL TO COME. The two answer different questions and are deliberately not merged: this
	// one paces a budget across the days it can still be spent on, so the day in progress counts.
	const [year, monthNumber] = month.split('-').map(Number);
	const now = new Date();
	const isCurrentMonth = now.getUTCFullYear() === year && now.getUTCMonth() + 1 === monthNumber;
	if (!isCurrentMonth) return 0;

	const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
	return daysInMonth - now.getUTCDate() + 1;
}

// Excludes transfer/investment: these natures don't feed budgets/insights unless an
// explicit budget targets them (see CLAUDE.md) — no explicit budget context here.
//
// Over allocations, so a split purchase's grocery part counts under groceries. With OD-4 the
// exclusion is now per part too: the transfer half of a mixed purchase drops out while its
// spending half stays, which is the pair of answers a per-transaction read could not give.
export function spendByEffectiveCategory(allocations: CategoryAllocation[]): Map<string, number> {
	const spend = new Map<string, number>();
	for (const allocation of allocations) {
		if (allocation.kind !== 'expense') continue;
		if (allocation.nature === 'transfer' || allocation.nature === 'investment') continue;
		spend.set(
			allocation.category,
			(spend.get(allocation.category) ?? 0) + Math.abs(allocation.amountCents)
		);
	}
	return spend;
}

function shiftMonth(month: string, offset: number): string {
	const [year, monthNumber] = month.split('-').map(Number);
	const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
	return `${date.getUTCFullYear()}-${`${date.getUTCMonth() + 1}`.padStart(2, '0')}`;
}

export async function loadDashboardInsights(userId: string): Promise<DashboardInsights> {
	const currentMonth = getCurrentMonth();
	const historyMonths = Array.from({ length: HISTORY_MONTHS }, (_, index) =>
		shiftMonth(currentMonth, -(index + 1))
	);

	const [currentMonthData, historyData, uncategorizedCount] = await Promise.all([
		readDashboardData(userId, currentMonth),
		Promise.all(historyMonths.map((month) => readDashboardData(userId, month))),
		countUncategorizedTransactions(userId)
	]);

	const summary = summarizeBudgetAllocations(
		currentMonthData.allocations,
		currentMonthData.budgets,
		currentMonth
	);
	const remainingDays = getRemainingDaysInMonth(currentMonth);
	const { alerts, overflowCount } = computeBudgetAlerts(
		summary.categorySummaries,
		currentMonthData.allocations,
		currentMonthData.transactions,
		remainingDays
	);

	const currentSpendByCategory = spendByEffectiveCategory(currentMonthData.allocations);
	const historicalMonthSpends = historyData.map((data) =>
		spendByEffectiveCategory(data.allocations)
	);
	const unusualSpending = computeUnusualSpendingInsight(
		currentSpendByCategory,
		historicalMonthSpends
	);

	return {
		alerts,
		alertOverflowCount: overflowCount,
		unusualSpending,
		uncategorizedCount
	};
}
