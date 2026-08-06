import type { Transaction } from '$lib/domain/transaction';
import type { CategoryAllocation } from '$lib/domain/allocation';
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
	mapTransactionAllocations,
	mapTransactionWithNature
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
	const [dashboardData, previous, categories, cashFlowForecast] = await Promise.all([
		readDashboardDataForRange(user.id, period),
		previousPeriod
			? readTransactionsForRange(user.id, previousPeriod.from, previousPeriod.to)
			: Promise.resolve({ transactions: [], allocations: [] }),
		prisma.category.findMany({
			where: { userId: user.id },
			select: { name: true, defaultKey: true }
		}),
		loadCashFlowForecast(user.id, FORECAST_REPORTS_HORIZON_DAYS).then(toDisplayCashFlowForecast)
	]);
	const { transactions, allocations } = dashboardData;
	const previousReport =
		previousPeriod && previous.transactions.length > 0
			? buildPeriodReport(previous.transactions, previous.allocations, previousPeriod.label)
			: undefined;

	return {
		month: period.budgetMonth,
		period,
		periodQuery: serializePeriodParams(period),
		report: buildPeriodReport(transactions, allocations, period.label, previousReport, {
			// All-time: the epoch lower bound would inflate the day count (~20k days) and crush
			// the per-day average — fall back to the span actually covered by transactions.
			dayCount: period.key === 'all-time' ? undefined : getDayCount(period.from, period.to)
		}),
		categories,
		cashFlowForecast,
		forecastHorizonMonths: FORECAST_REPORTS_HORIZON_MONTHS
	};
};

/**
 * The comparison period's two views, read together.
 *
 * It maps through the SHARED mappers rather than its own copy. It used to have one, which resolved
 * `type` to `undefined` where the dashboard's resolved it from the sign — behaviourally identical,
 * since every consumer goes through getTransactionKind, and exactly the kind of near-copy that
 * stops being identical the moment one of the two learns something the other does not. Adding
 * per-part nature to only one of them was that moment.
 */
async function readTransactionsForRange(
	userId: string,
	from: Date,
	to: Date
): Promise<{ transactions: Transaction[]; allocations: CategoryAllocation[] }> {
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

	return {
		transactions: transactions.map((transaction) =>
			mapTransactionWithNature(transaction, mappingMap)
		),
		allocations: transactions.flatMap((transaction) =>
			mapTransactionAllocations(transaction, mappingMap)
		)
	};
}

function getDayCount(from: Date, to: Date): number {
	return Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
}
