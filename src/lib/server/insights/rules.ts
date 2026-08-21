import * as m from '$lib/paraglide/messages';
import type { MonthlyBudgetSummary } from '$lib/domain/budget';
import type { TransactionSummary, BudgetInsight } from './types';
import { formatMoney, money } from '$lib/domain/money';

export function generateRuleInsights(
	summary: MonthlyBudgetSummary,
	transactionSummary?: TransactionSummary
): BudgetInsight[] {
	const insights: BudgetInsight[] = [];

	if (summary.balanceCents < 0) {
		insights.push({
			id: 'negative-balance',
			severity: 'critical',
			category: 'budget',
			source: 'rules',
			title: m.insight_negative_balance_title(),
			message: m.insight_negative_balance_message()
		});
	} else if (summary.incomeCents > 0 && summary.balanceCents < summary.incomeCents * 0.1) {
		insights.push({
			id: 'low-buffer',
			severity: 'warning',
			category: 'budget',
			source: 'rules',
			title: m.insight_low_buffer_title(),
			message: m.insight_low_buffer_message()
		});
	}

	if (summary.incomeCents > 0 && summary.expenseCents > summary.incomeCents) {
		insights.push({
			id: 'expenses-above-income',
			severity: 'critical',
			category: 'spending',
			source: 'rules',
			title: m.insight_expenses_above_income_title(),
			message: m.insight_expenses_above_income_message()
		});
	}

	for (const category of summary.categorySummaries) {
		if (!category.isOverBudget) continue;
		insights.push({
			id: `over-budget-${slugify(category.category)}`,
			severity: 'warning',
			category: 'budget',
			source: 'rules',
			title: m.insight_over_budget_title({ category: category.category }),
			message: m.insight_over_budget_message({
				category: category.category,
				// Formatted rather than divided: the raw quotient reached the message as "15.5",
				// which is neither the locale's decimal separator nor the locale's currency.
				amount: formatMoney(money(Math.abs(category.remainingCents)))
			})
		});
	}

	const mainCategory = transactionSummary?.topCategories[0];
	if (mainCategory && transactionSummary.expenseCents > 0) {
		const ratio = mainCategory.amountCents / transactionSummary.expenseCents;
		if (ratio >= 0.4) {
			insights.push({
				id: `top-category-${slugify(mainCategory.category)}`,
				severity: 'info',
				category: 'spending',
				source: 'rules',
				title: m.insight_top_category_title({ category: mainCategory.category }),
				message: m.insight_top_category_message()
			});
		}
	}

	if ((transactionSummary?.previousMonth?.expenseDeltaCents ?? 0) > 0) {
		insights.push({
			id: 'expenses-increased',
			severity: 'warning',
			category: 'spending',
			source: 'rules',
			title: m.insight_expenses_increased_title(),
			message: m.insight_expenses_increased_message()
		});
	}

	if (transactionSummary?.recurringPayments.length) {
		insights.push({
			id: 'recurring-payments',
			severity: 'info',
			category: 'recurring',
			source: 'rules',
			title: m.insight_recurring_payments_title(),
			message: m.insight_recurring_payments_message()
		});
	}

	if (insights.length === 0) {
		insights.push({
			id: 'budget-on-track',
			severity: 'info',
			category: 'budget',
			source: 'rules',
			title: m.insight_on_track_title(),
			message: m.insight_on_track_message()
		});
	}

	return insights;
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}
