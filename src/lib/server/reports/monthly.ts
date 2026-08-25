import * as m from '$lib/paraglide/messages';
import type { Transaction } from '$lib/domain/transaction';
import type { CategoryAllocation, SplitIndicator } from '$lib/domain/allocation';
import { splitIndicatorsByTransactionId } from '$lib/domain/allocation';
import { getTransactionKind } from '$lib/domain/transaction';
import { getSimilarAmountGroups, normalizeRecurringLabel } from '$lib/domain/recurrence';
import { categoryDisplayName } from '$lib/domain/categoryLabels';
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
	/**
	 * `null` for an unsplit transaction. The RANKING and the displayed `category`/`amountCents`
	 * above are still the PARENT's — OD-3, unchanged by this field — so a répartie entry here reads
	 * "this 80,00 € Alimentation purchase was split" rather than re-ranking or re-labelling the row
	 * from its parts. What this field adds is the ANSWER to "into what": the same breakdown
	 * `splitIndicatorOf` gives the transaction list, reused rather than restated, and reaching the
	 * local-model prompt automatically (`toPromptPayload` walks it like any other nested object; see
	 * `server/insights/summary.ts`). It carries no `note` — `SplitIndicator` has none to carry.
	 */
	splitIndicator: SplitIndicator | null;
}

export interface RecurringPayment {
	/** Stable per-stream identity for the client — the stream's most recent transaction id, the same
	 *  anchor the forecast view's `CashFlowForecastFlowView.id` uses.
	 *
	 *  None of the DISPLAYED fields identifies a stream, and that is not an oversight to work around
	 *  with a composite key: grouping and display run through two different normalizers.
	 *  `normalizeRecurringLabel` decides which transactions form a group and keeps the whole label,
	 *  while `anonymizeMerchant` truncates the displayed one at 28 characters — so two branches of
	 *  one chain at one price group APART and display IDENTICALLY. `getSimilarAmountGroups` supplies
	 *  a second source of near-collisions on the same triple. A route keying an `#each` on any of
	 *  them renders a duplicate key, which Svelte 5 throws on at runtime in production builds and
	 *  which blanks the whole route. */
	id: string;
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
	allocations: CategoryAllocation[],
	month: string,
	previousMonth?: Pick<MonthlyReport, 'month' | 'incomeCents' | 'expenseCents' | 'balanceCents'>
): MonthlyReport {
	return buildPeriodReport(
		getTransactionsForMonth(transactions, month),
		getAllocationsForMonth(allocations, month),
		month,
		previousMonth,
		{ dayCount: getDaysInMonth(month) }
	);
}

/**
 * A period's report, built from BOTH views, each answering only what it can answer.
 *
 * The split follows the blast-radius table and is the whole reason this function takes two arrays:
 *
 *  - MONEY, from allocations: `topCategories` (where the money went) and `natureAnalysis`.
 *  - IDENTITY, from transactions: `transactionCount` (how many bank lines), `largestExpenses`
 *    (OD-3 — a répartition is one purchase, ranked whole) and `recurringPayments` (a stream is
 *    anchored on transactions; a part has no identity to recur).
 *
 *    `largestExpenses` also takes `allocations`, alongside `expenses`, but only to ANNOTATE each
 *    ranked row with its `SplitIndicator` (`AnonymizedExpense.splitIndicator`) — OD-3 itself is
 *    unchanged: ranking, `category` and `amountCents` still come from the transaction, whole. The
 *    annotation exists so a surface that lists parent-shaped rows (this one, and the AI payload
 *    that reuses it) can say a répartition exists without pretending the row is now the parts.
 *  - EITHER, and read from allocations for consistency: `incomeCents` / `expenseCents`. Every
 *    allocation of a transaction carries that transaction's kind, so the two sums are equal by
 *    construction — the conservation theorem, and the guard measures it rather than assuming it.
 *
 * Passing the arrays the wrong way round does not compile: a CategoryAllocation has no `label`, and
 * a Transaction has no `transactionId`.
 */
export function buildPeriodReport(
	transactions: Transaction[],
	allocations: CategoryAllocation[],
	period: string,
	previousPeriod?: Pick<MonthlyReport, 'month' | 'incomeCents' | 'expenseCents' | 'balanceCents'>,
	options: { dayCount?: number } = {}
): MonthlyReport {
	const expenses = transactions.filter(
		(transaction) => getTransactionKind(transaction) === 'expense'
	);
	const expenseAllocations = allocations.filter((allocation) => allocation.kind === 'expense');
	const incomeCents = allocations
		.filter((allocation) => allocation.kind === 'income')
		.reduce((total, allocation) => total + Math.abs(allocation.amountCents), 0);
	const expenseCents = expenseAllocations.reduce(
		(total, allocation) => total + Math.abs(allocation.amountCents),
		0
	);
	const balanceCents = incomeCents - expenseCents;
	const dayCount = Math.max(1, options.dayCount ?? getCoveredDayCount(transactions));
	const topCategories = getTopCategories(expenseAllocations, expenseCents);
	const largestExpenses = getLargestExpenses(expenses, expenseAllocations);
	const recurringPayments = getRecurringPayments(expenses);
	const natureAnalysis = analyzeTransactionNatures(allocations);
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

export function getAllocationsForMonth(
	allocations: CategoryAllocation[],
	month: string
): CategoryAllocation[] {
	return allocations.filter((allocation) => allocation.date.startsWith(`${month}-`));
}

/**
 * The per-category expense breakdown, over ALLOCATIONS.
 *
 * `transactionCount` counts DISTINCT transactions, not entries. Counting entries would be the
 * easier reduce and would make "3 transactions" a false claim the moment two of them are parts of
 * one purchase — the double-count moved from the amount to the count, where it is harder to spot
 * because the euros still add up. Distinctness is exactly what `transactionId` exists on an
 * allocation for; it is the one identity question an allocation may answer.
 */
export function getTopCategories(
	expenses: CategoryAllocation[],
	totalExpenseCents?: number
): CategoryTotal[] {
	const categories = new Map<string, { amountCents: number; transactionIds: Set<string> }>();

	for (const allocation of expenses) {
		const current = categories.get(allocation.category) ?? {
			amountCents: 0,
			transactionIds: new Set<string>()
		};
		current.amountCents += Math.abs(allocation.amountCents);
		current.transactionIds.add(allocation.transactionId);
		categories.set(allocation.category, current);
	}

	const total =
		totalExpenseCents ?? expenses.reduce((sum, expense) => sum + Math.abs(expense.amountCents), 0);

	return [...categories.entries()]
		.map(([category, value]) => ({
			category,
			amountCents: value.amountCents,
			transactionCount: value.transactionIds.size,
			percentageOfExpenses: total > 0 ? value.amountCents / total : 0
		}))
		.sort((left, right) => right.amountCents - left.amountCents)
		.slice(0, 5);
}

export function getLargestExpenses(
	expenses: Transaction[],
	allocations: ReadonlyArray<CategoryAllocation>
): AnonymizedExpense[] {
	const splitIndicators = splitIndicatorsByTransactionId(allocations);

	return [...expenses]
		.sort((left, right) => Math.abs(right.amountCents) - Math.abs(left.amountCents))
		.slice(0, 5)
		.map((transaction) => ({
			label: anonymizeLabel(transaction.label, transaction.category),
			amountCents: Math.abs(transaction.amountCents),
			category: transaction.category,
			splitIndicator: splitIndicators.get(transaction.id) ?? null
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
				id: sortedGroup[sortedGroup.length - 1].id,
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

/**
 * The merchant half of the anonymization, on its own: a raw bank label stripped of IBANs,
 * references, dates, long digit runs and payment-instrument noise, title-cased, and replaced by a
 * neutral fallback when nothing survives.
 *
 * Exported because a surface that already shows the category in its own field (the upcoming-bills
 * rows, whose sub-line reads "Prélèvement · le 31 de chaque mois · Abonnements") must not print it
 * a second time inside the label — and because `getInitials` over the composed
 * "Netflix - Abonnements" reads the hyphen as a word and renders "N-" on the avatar.
 *
 * Takes no `category`: the merchant does not depend on it, and neither does the fallback.
 * `anonymizeLabel` remains the composed form and the only thing every existing caller uses.
 */
export function anonymizeMerchant(label: string): string {
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

	return merchant ? toTitleCase(merchant) : m.reports_expense_fallback_label();
}

/**
 * The merchant composed with its DISPLAYED category.
 *
 * `categoryDisplayName` rather than the raw argument, and that is the whole of the 0.14.0 defect:
 * a stored category name is the name (#162) and passes through untouched, but
 * `UNCLASSIFIED_CATEGORY` is a technical slug that must never reach a screen. Composed raw, it put
 * "Zorglub - uncategorized" on /reports in a table whose next column already read
 * "Non catégorisé", and in the dashboard's forecast-chart tooltip. Four render paths go through
 * this one line, which is why the repair is here and not at any of them.
 *
 * Still byte-identical for every ordinary category, which is what the recorded literals in the
 * spec pin.
 */
export function anonymizeLabel(label: string, category: string): string {
	return `${anonymizeMerchant(label)} - ${categoryDisplayName(category)}`;
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
