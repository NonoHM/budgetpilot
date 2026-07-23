import type { CategoryBudgetSummary } from '$lib/domain/budget';
import { getTransactionKind, type Transaction } from '$lib/domain/transaction';
import { readDashboardData, getCurrentMonth } from '$lib/server/budget/dashboard';
import { summarizeBudgetTransactions } from '$lib/domain/budget';
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

export function computeBudgetAlerts(
	categorySummaries: CategoryBudgetSummary[],
	transactionsThisMonth: Transaction[],
	remainingDays: number
): { alerts: BudgetAlert[]; overflowCount: number } {
	const ranked = rankAlertedBudgets(categorySummaries);
	const shown = ranked.slice(0, MAX_ALERTS);

	const alerts = shown.map((summary) => {
		const topExpenses = transactionsThisMonth
			.filter(
				(transaction) =>
					transaction.category === summary.category && getTransactionKind(transaction) === 'expense'
			)
			.sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents))
			.slice(0, MAX_ALERT_EXPENSES)
			.map((transaction) => ({
				label: transaction.label,
				date: transaction.date,
				amountCents: transaction.amountCents
			}));

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
	// Uses local time throughout (not UTC) to stay consistent with getCurrentMonth(),
	// which is also local-time-based — mixing bases here would misdetect "current month"
	// during the first hours of each month in UTC+ timezones.
	const [year, monthNumber] = month.split('-').map(Number);
	const now = new Date();
	const isCurrentMonth = now.getFullYear() === year && now.getMonth() + 1 === monthNumber;
	if (!isCurrentMonth) return 0;

	const daysInMonth = new Date(year, monthNumber, 0).getDate();
	return daysInMonth - now.getDate() + 1;
}

// Excludes transfer/investment: these natures don't feed budgets/insights unless an
// explicit budget targets them (see CLAUDE.md) — no explicit budget context here.
export function spendByEffectiveCategory(transactions: Transaction[]): Map<string, number> {
	const spend = new Map<string, number>();
	for (const transaction of transactions) {
		if (getTransactionKind(transaction) !== 'expense') continue;
		if (transaction.nature === 'transfer' || transaction.nature === 'investment') continue;
		spend.set(
			transaction.category,
			(spend.get(transaction.category) ?? 0) + Math.abs(transaction.amountCents)
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

	const summary = summarizeBudgetTransactions(
		currentMonthData.transactions,
		currentMonthData.budgets,
		currentMonth
	);
	const remainingDays = getRemainingDaysInMonth(currentMonth);
	const { alerts, overflowCount } = computeBudgetAlerts(
		summary.categorySummaries,
		currentMonthData.transactions,
		remainingDays
	);

	const currentSpendByCategory = spendByEffectiveCategory(currentMonthData.transactions);
	const historicalMonthSpends = historyData.map((data) =>
		spendByEffectiveCategory(data.transactions)
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
