import type { Transaction } from './transaction';
import { getTransactionKind } from './transaction';
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
	transactions: Transaction[],
	budgets: CategoryBudget[],
	month: string
): MonthlyBudgetSummary {
	const monthlyTransactions = transactions.filter((transaction) =>
		transaction.date.startsWith(`${month}-`)
	);

	return summarizeBudgetTransactions(monthlyTransactions, budgets, month);
}

export function summarizeBudgetTransactions(
	transactions: Transaction[],
	budgets: CategoryBudget[],
	period: string
): MonthlyBudgetSummary {
	const incomeCents = transactions
		.filter((transaction) => getTransactionKind(transaction) === 'income')
		.reduce((total, transaction) => total + Math.abs(transaction.amountCents), 0);
	const expenseCents = transactions
		.filter((transaction) => getTransactionKind(transaction) === 'expense')
		.reduce((total, transaction) => total + Math.abs(transaction.amountCents), 0);
	const spentByCategory = new Map<string, number>();
	const budgetCategories = new Set(budgets.map((budget) => budget.category));
	for (const transaction of transactions) {
		if (!shouldCountTransactionForBudget(transaction, budgetCategories)) continue;
		spentByCategory.set(
			transaction.category,
			(spentByCategory.get(transaction.category) ?? 0) + Math.abs(transaction.amountCents)
		);
	}

	const categorySummaries = budgets.map((budget) => {
		const spentCents = spentByCategory.get(budget.category) ?? 0;
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

function shouldCountTransactionForBudget(
	transaction: Transaction,
	budgetCategories: Set<string>
): boolean {
	if (getTransactionKind(transaction) !== 'expense') return false;
	if (budgetCategories.has(transaction.category)) return true;

	return transaction.nature === 'spending' || transaction.nature === 'fee' || !transaction.nature;
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

export function formatCents(amountCents: number, locale = getLocale(), currency = 'EUR'): string {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency
	}).format(amountCents / 100);
}
