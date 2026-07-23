import type { MonthlyBudgetSummary } from '$lib/domain/budget';
import type { Transaction } from '$lib/domain/transaction';
import { getTransactionKind } from '$lib/domain/transaction';
import { buildPeriodReport } from '$lib/server/reports/monthly';
import type { FlaggedCategoryLabels, TransactionSummary } from './types';

const MAX_FLAGGED_LABELS_PER_CATEGORY = 3;

export function buildTransactionSummary(
	transactions: Transaction[],
	monthlySummary: MonthlyBudgetSummary,
	previousMonth?: MonthlyBudgetSummary,
	options: { includeLabels?: boolean } = {}
): TransactionSummary {
	const previousMonthReport = previousMonth
		? {
				month: previousMonth.month,
				incomeCents: previousMonth.incomeCents,
				expenseCents: previousMonth.expenseCents,
				balanceCents: previousMonth.balanceCents
			}
		: undefined;
	const report = buildPeriodReport(transactions, monthlySummary.month, previousMonthReport);
	const flaggedCategoryLabels = options.includeLabels
		? getFlaggedCategoryLabels(transactions, monthlySummary)
		: undefined;

	return {
		period: monthlySummary.month,
		incomeCents: monthlySummary.incomeCents,
		expenseCents: monthlySummary.expenseCents,
		balanceCents: monthlySummary.balanceCents,
		transactionCount: report.transactionCount,
		topCategories: report.topCategories,
		largestExpenses: options.includeLabels
			? report.largestExpenses
			: report.largestExpenses.map((expense) => ({ ...expense, label: 'Dépense' })),
		recurringPayments: options.includeLabels
			? report.recurringPayments
			: report.recurringPayments.map((payment) => ({ ...payment, label: 'Paiement récurrent' })),
		previousMonth: report.previousMonth,
		flaggedCategoryLabels
	};
}

function getFlaggedCategoryLabels(
	transactions: Transaction[],
	monthlySummary: MonthlyBudgetSummary
): FlaggedCategoryLabels[] {
	return monthlySummary.categorySummaries
		.filter((summary) => summary.status !== 'ok')
		.map((summary) => ({
			category: summary.category,
			labels: transactions
				.filter(
					(transaction) =>
						transaction.category === summary.category &&
						getTransactionKind(transaction) === 'expense'
				)
				.sort((left, right) => Math.abs(right.amountCents) - Math.abs(left.amountCents))
				.slice(0, MAX_FLAGGED_LABELS_PER_CATEGORY)
				.map((transaction) => transaction.label)
		}))
		.filter((entry) => entry.labels.length > 0);
}
