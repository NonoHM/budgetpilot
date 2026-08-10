import type { MonthlyBudgetSummary } from '$lib/domain/budget';
import type { Transaction } from '$lib/domain/transaction';
import type { CategoryAllocation } from '$lib/domain/allocation';
import { buildPeriodReport } from '$lib/server/reports/monthly';
import type { FlaggedCategoryLabels, TransactionSummary } from './types';

const MAX_FLAGGED_LABELS_PER_CATEGORY = 3;
const ANONYMIZED_EXPENSE_LABEL = 'Expense';
const ANONYMIZED_RECURRING_LABEL = 'Recurring payment';

export function buildTransactionSummary(
	transactions: Transaction[],
	allocations: CategoryAllocation[],
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
	const report = buildPeriodReport(
		transactions,
		allocations,
		monthlySummary.month,
		previousMonthReport
	);
	const flaggedCategoryLabels = options.includeLabels
		? getFlaggedCategoryLabels(transactions, allocations, monthlySummary)
		: undefined;

	return {
		period: monthlySummary.month,
		incomeCents: monthlySummary.incomeCents,
		expenseCents: monthlySummary.expenseCents,
		balanceCents: monthlySummary.balanceCents,
		transactionCount: report.transactionCount,
		topCategories: report.topCategories,
		// These placeholders replace real labels when the user hasn't opted into sharing them.
		// They only ever reach the model, never the UI, so they're plain English code
		// constants rather than i18n messages.
		largestExpenses: options.includeLabels
			? report.largestExpenses
			: report.largestExpenses.map((expense) => ({ ...expense, label: ANONYMIZED_EXPENSE_LABEL })),
		recurringPayments: options.includeLabels
			? report.recurringPayments
			: report.recurringPayments.map((payment) => ({
					...payment,
					label: ANONYMIZED_RECURRING_LABEL
				})),
		previousMonth: report.previousMonth,
		flaggedCategoryLabels
	};
}

/**
 * SELECTED BY ALLOCATION, DISPLAYED BY PARENT — the same shape as computeBudgetAlerts' top
 * expenses, and it matters more here because this is what reaches the model.
 *
 * A transaction whose PART landed in a flagged category belongs in that category's label list; a
 * transaction whose parent category merely matches, while its money went elsewhere, does not. Rank
 * on the part's amount, print the parent's label. One transaction appears at most once per
 * category, even when two of its parts share that category.
 *
 * Note what does NOT travel: a part's free-text `note` is never in a CategoryAllocation and so can
 * never reach this payload. That is a property of the type, not a filter applied here.
 */
function getFlaggedCategoryLabels(
	transactions: Transaction[],
	allocations: CategoryAllocation[],
	monthlySummary: MonthlyBudgetSummary
): FlaggedCategoryLabels[] {
	const labelsByTransactionId = new Map(
		transactions.map((transaction) => [transaction.id, transaction.label])
	);

	return monthlySummary.categorySummaries
		.filter((summary) => summary.status !== 'ok')
		.map((summary) => {
			const perTransaction = new Map<string, number>();
			for (const allocation of allocations) {
				if (allocation.category !== summary.category || allocation.kind !== 'expense') continue;
				perTransaction.set(
					allocation.transactionId,
					(perTransaction.get(allocation.transactionId) ?? 0) + allocation.amountCents
				);
			}

			return {
				category: summary.category,
				labels: [...perTransaction.entries()]
					.sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]))
					.slice(0, MAX_FLAGGED_LABELS_PER_CATEGORY)
					.map(([transactionId]) => labelsByTransactionId.get(transactionId) ?? '')
			};
		})
		.filter((entry) => entry.labels.length > 0);
}
