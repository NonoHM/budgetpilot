import type { Transaction, TransactionNature, TransactionSource } from '$lib/domain/transaction';
import {
	getPreviousMonthRange,
	parseDateRange,
	serializePeriodParams
} from '$lib/server/date-range';
import { requireUser } from '$lib/server/auth';
import { readDashboardDataForRange } from '$lib/server/budget/dashboard';
import { prisma } from '$lib/server/db';
import { buildPeriodReport } from '$lib/server/reports/monthly';
import {
	buildCategoryNatureMap,
	EFFECTIVE_CATEGORY_SELECT,
	getEffectiveCategory,
	getEffectiveTransactionNature
} from '$lib/server/transactions/nature';
import {
	FORECAST_REPORTS_HORIZON_DAYS,
	FORECAST_REPORTS_HORIZON_MONTHS,
	loadCashFlowForecast,
	toDisplayCashFlowForecast
} from '$lib/server/forecast';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	const period = parseDateRange(url.searchParams);
	const previousPeriod = getPreviousMonthRange(period);
	const [dashboardData, previousTransactions, categories, cashFlowForecast] = await Promise.all([
		readDashboardDataForRange(user.id, period),
		previousPeriod
			? readTransactionsForRange(user.id, previousPeriod.from, previousPeriod.to)
			: Promise.resolve([]),
		prisma.category.findMany({
			where: { userId: user.id },
			select: { name: true, defaultKey: true }
		}),
		loadCashFlowForecast(user.id, FORECAST_REPORTS_HORIZON_DAYS).then(toDisplayCashFlowForecast)
	]);
	const transactions = dashboardData.transactions;
	const previousReport =
		previousPeriod && previousTransactions.length > 0
			? buildPeriodReport(previousTransactions, previousPeriod.label)
			: undefined;

	return {
		month: period.budgetMonth,
		period,
		periodQuery: serializePeriodParams(period),
		report: buildPeriodReport(transactions, period.label, previousReport, {
			// All-time: the epoch lower bound would inflate the day count (~20k days) and crush
			// the per-day average — fall back to the span actually covered by transactions.
			dayCount: period.key === 'all-time' ? undefined : getDayCount(period.from, period.to)
		}),
		categories,
		cashFlowForecast,
		forecastHorizonMonths: FORECAST_REPORTS_HORIZON_MONTHS
	};
};

async function readTransactionsForRange(
	userId: string,
	from: Date,
	to: Date
): Promise<Transaction[]> {
	const mappings = await prisma.categoryNatureMapping.findMany({
		where: { userId },
		orderBy: { categoryName: 'asc' },
		select: { categoryName: true, nature: true }
	});
	const mappingMap = buildCategoryNatureMap(mappings);
	const transactions = await prisma.transaction.findMany({
		where: {
			userId,
			date: {
				gte: from,
				lt: to
			}
		},
		select: {
			id: true,
			date: true,
			label: true,
			amountCents: true,
			type: true,
			source: true,
			natureManual: true,
			...EFFECTIVE_CATEGORY_SELECT
		},
		orderBy: { date: 'asc' }
	});

	return transactions.map((transaction) => {
		// Resolved once and reused for the nature lookup below. It was spelled out twice here, and
		// the two had to agree: a transaction whose displayed category and whose nature-lookup
		// category disagreed would report a nature belonging to a category the user cannot see.
		const category = getEffectiveCategory(transaction);
		const type =
			transaction.type === 'income' || transaction.type === 'expense'
				? transaction.type
				: undefined;

		return {
			id: transaction.id,
			date: transaction.date.toISOString().slice(0, 10),
			label: transaction.label,
			amountCents: transaction.amountCents,
			type,
			category,
			source: transaction.source as TransactionSource,
			nature: getEffectiveTransactionNature(
				{
					amountCents: transaction.amountCents,
					type,
					category,
					natureManual: transaction.natureManual as TransactionNature | null
				},
				mappingMap
			).nature
		};
	});
}

function getDayCount(from: Date, to: Date): number {
	return Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
}
