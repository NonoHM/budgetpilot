import * as m from '$lib/paraglide/messages';
import type { Transaction } from '$lib/domain/transaction';
import { getTransactionKind } from '$lib/domain/transaction';
import { getSimilarAmountGroups, normalizeRecurringLabel } from '$lib/domain/recurrence';
import {
	analyzeTransactionNatures,
	type TransactionNatureAnalysis
} from '$lib/server/transactions/nature';

export interface CategoryTotal {
	category: string;
	amountCents: number;
	transactionCount: number;
	percentageOfExpenses: number;
}

export interface AnonymizedExpense {
	label: string;
	amountCents: number;
	category: string;
}

export interface RecurringPayment {
	label: string;
	amountCents: number;
	totalAmountCents: number;
	count: number;
	category: string;
	lastDate: string;
	confidence: 'faible' | 'moyenne' | 'haute';
}

export interface MonthlyReportComparison {
	month: string;
	incomeDeltaCents: number;
	expenseDeltaCents: number;
	balanceDeltaCents: number;
}

export type TakeawayCode =
	| 'balance_positive'
	| 'balance_negative'
	| 'top_category'
	| 'recurring'
	| 'investment'
	| 'no_expense'
	| 'expense_increasing'
	| 'expense_decreasing';

export interface Takeaway {
	code: TakeawayCode;
	category?: string;
	percent?: string;
	count?: number;
}

export interface MonthlyReport {
	month: string;
	incomeCents: number;
	expenseCents: number;
	balanceCents: number;
	transactionCount: number;
	expenseAveragePerDayCents: number;
	savingsRate: number | null;
	topCategories: CategoryTotal[];
	largestExpenses: AnonymizedExpense[];
	recurringPayments: RecurringPayment[];
	natureAnalysis: TransactionNatureAnalysis;
	takeaways: Takeaway[];
	previousMonth?: MonthlyReportComparison;
}

export function buildMonthlyReport(
	transactions: Transaction[],
	month: string,
	previousMonth?: Pick<MonthlyReport, 'month' | 'incomeCents' | 'expenseCents' | 'balanceCents'>
): MonthlyReport {
	const monthlyTransactions = getTransactionsForMonth(transactions, month);
	return buildPeriodReport(monthlyTransactions, month, previousMonth, {
		dayCount: getDaysInMonth(month)
	});
}

export function buildPeriodReport(
	transactions: Transaction[],
	period: string,
	previousPeriod?: Pick<MonthlyReport, 'month' | 'incomeCents' | 'expenseCents' | 'balanceCents'>,
	options: { dayCount?: number } = {}
): MonthlyReport {
	const expenses = transactions.filter(
		(transaction) => getTransactionKind(transaction) === 'expense'
	);
	const incomeCents = transactions
		.filter((transaction) => getTransactionKind(transaction) === 'income')
		.reduce((total, transaction) => total + Math.abs(transaction.amountCents), 0);
	const expenseCents = expenses.reduce(
		(total, transaction) => total + Math.abs(transaction.amountCents),
		0
	);
	const balanceCents = incomeCents - expenseCents;
	const dayCount = Math.max(1, options.dayCount ?? getCoveredDayCount(transactions));
	const topCategories = getTopCategories(expenses, expenseCents);
	const largestExpenses = getLargestExpenses(expenses);
	const recurringPayments = getRecurringPayments(expenses);
	const natureAnalysis = analyzeTransactionNatures(transactions);
	const previousMonth = previousPeriod
		? {
				month: previousPeriod.month,
				incomeDeltaCents: incomeCents - previousPeriod.incomeCents,
				expenseDeltaCents: expenseCents - previousPeriod.expenseCents,
				balanceDeltaCents: balanceCents - previousPeriod.balanceCents
			}
		: undefined;

	return {
		month: period,
		incomeCents,
		expenseCents,
		balanceCents,
		transactionCount: transactions.length,
		expenseAveragePerDayCents: Math.round(expenseCents / dayCount),
		savingsRate: incomeCents > 0 ? balanceCents / incomeCents : null,
		topCategories,
		largestExpenses,
		recurringPayments,
		natureAnalysis,
		takeaways: buildTakeaways({
			incomeCents,
			expenseCents,
			balanceCents,
			topCategories,
			natureAnalysis,
			recurringPayments,
			previousMonth
		}),
		previousMonth
	};
}

export function getTransactionsForMonth(transactions: Transaction[], month: string): Transaction[] {
	return transactions.filter((transaction) => transaction.date.startsWith(`${month}-`));
}

export function getTopCategories(
	expenses: Transaction[],
	totalExpenseCents?: number
): CategoryTotal[] {
	const categories = new Map<string, { amountCents: number; transactionCount: number }>();

	for (const transaction of expenses) {
		const current = categories.get(transaction.category) ?? { amountCents: 0, transactionCount: 0 };
		categories.set(transaction.category, {
			amountCents: current.amountCents + Math.abs(transaction.amountCents),
			transactionCount: current.transactionCount + 1
		});
	}

	const total =
		totalExpenseCents ?? expenses.reduce((sum, expense) => sum + Math.abs(expense.amountCents), 0);

	return [...categories.entries()]
		.map(([category, value]) => ({
			category,
			...value,
			percentageOfExpenses: total > 0 ? value.amountCents / total : 0
		}))
		.sort((left, right) => right.amountCents - left.amountCents)
		.slice(0, 5);
}

export function getLargestExpenses(expenses: Transaction[]): AnonymizedExpense[] {
	return [...expenses]
		.sort((left, right) => Math.abs(right.amountCents) - Math.abs(left.amountCents))
		.slice(0, 5)
		.map((transaction) => ({
			label: anonymizeLabel(transaction.label, transaction.category),
			amountCents: Math.abs(transaction.amountCents),
			category: transaction.category
		}));
}

export function getRecurringPayments(expenses: Transaction[]): RecurringPayment[] {
	const groups = new Map<string, Transaction[]>();

	for (const transaction of expenses) {
		const normalizedLabel = normalizeRecurringLabel(transaction.label);
		if (!normalizedLabel) continue;

		const key = `${normalizedLabel}:${transaction.category}`;
		groups.set(key, [...(groups.get(key) ?? []), transaction]);
	}

	return [...groups.values()]
		.flatMap((group) => getSimilarAmountGroups(group))
		.filter((group) => group.length >= 2)
		.map((group) => {
			const sortedGroup = [...group].sort((left, right) => left.date.localeCompare(right.date));
			const amounts = sortedGroup.map((transaction) => Math.abs(transaction.amountCents));
			const amountCents = Math.round(
				amounts.reduce((total, amount) => total + amount, 0) / sortedGroup.length
			);
			const totalAmountCents = amounts.reduce((total, amount) => total + amount, 0);
			const spreadCents = Math.max(...amounts) - Math.min(...amounts);

			return {
				label: anonymizeLabel(sortedGroup[0].label, sortedGroup[0].category),
				amountCents,
				totalAmountCents,
				count: sortedGroup.length,
				category: sortedGroup[0].category,
				lastDate: sortedGroup[sortedGroup.length - 1].date,
				confidence: getRecurringConfidence(sortedGroup.length, spreadCents)
			};
		})
		.sort((left, right) => right.amountCents * right.count - left.amountCents * left.count)
		.slice(0, 5);
}

export function anonymizeLabel(label: string, category: string): string {
	const merchant = label
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[A-Z]{2}\d{2}[A-Z0-9]{11,30}/gi, ' ')
		.replace(/\b(?:REF[A-Z0-9]{3,}|[A-Z0-9]*\d[A-Z0-9]{6,})\b/gi, ' ')
		.replace(/\b\d{2}[/-]\d{2}(?:[/-]\d{2,4})?\b/g, ' ')
		.replace(/\b\d{3,}\b/g, ' ')
		.replace(
			/\b(?:ABONNEMENT|AUTH|CB|CARTE|CREDIT|DEBIT|IBAN|MASTERCARD|PRELEVEMENT|REFERENCE|SEPA|VIREMENT|VISA)\b/gi,
			' '
		)
		.replace(/[^a-zA-Z]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 28);

	return merchant
		? `${toTitleCase(merchant)} - ${category}`
		: `${m.reports_expense_fallback_label()} - ${category}`;
}

function getCoveredDayCount(transactions: Transaction[]): number {
	if (transactions.length === 0) return 1;
	const dates = transactions.map((transaction) =>
		new Date(`${transaction.date}T00:00:00.000Z`).getTime()
	);
	const min = Math.min(...dates);
	const max = Math.max(...dates);
	return Math.max(1, Math.round((max - min) / 86_400_000) + 1);
}

function getDaysInMonth(month: string): number {
	const [year, monthIndex] = month.split('-').map(Number);
	if (!year || !monthIndex) return 30;

	return new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
}

function getRecurringConfidence(
	count: number,
	spreadCents: number
): 'faible' | 'moyenne' | 'haute' {
	if (count >= 3 && spreadCents <= 100) return 'haute';
	if (count >= 2 && spreadCents <= 500) return 'moyenne';
	return 'faible';
}

function buildTakeaways(input: {
	incomeCents: number;
	expenseCents: number;
	balanceCents: number;
	topCategories: CategoryTotal[];
	natureAnalysis: TransactionNatureAnalysis;
	recurringPayments: RecurringPayment[];
	previousMonth?: MonthlyReportComparison;
}): Takeaway[] {
	const takeaways: Takeaway[] = [];
	takeaways.push({ code: input.balanceCents >= 0 ? 'balance_positive' : 'balance_negative' });

	const mainCategory = input.topCategories[0];
	if (mainCategory) {
		takeaways.push({
			code: 'top_category',
			category: mainCategory.category,
			percent: formatPercentage(mainCategory.percentageOfExpenses)
		});
	}

	if (input.recurringPayments.length > 0) {
		takeaways.push({ code: 'recurring', count: input.recurringPayments.length });
	}

	if (input.natureAnalysis.investmentCents > 0) {
		takeaways.push({ code: 'investment' });
	}

	if (takeaways.length < 2 && input.expenseCents === 0) {
		takeaways.push({ code: 'no_expense' });
	}

	if (input.previousMonth) {
		takeaways.push({
			code: input.previousMonth.expenseDeltaCents > 0 ? 'expense_increasing' : 'expense_decreasing'
		});
	}

	return takeaways.slice(0, 4);
}

function formatPercentage(value: number): string {
	return `${Math.round(value * 100)} %`;
}

function toTitleCase(value: string): string {
	return value.toLowerCase().replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}
