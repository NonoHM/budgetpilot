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
import { collectAllTransactions } from '$lib/server/transactions/batch';
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
			select: { name: true }
		}),
		loadCashFlowForecast(user.id, FORECAST_REPORTS_HORIZON_DAYS).then(toDisplayCashFlowForecast)
	]);
	const { transactions, allocations } = dashboardData;
	const previousReport =
		previousPeriod && previous.transactions.length > 0
			? buildPeriodReport(previous.transactions, previous.allocations, previousPeriod.label)
			: undefined;

	return {
		// The Periode panel's presets are a pure function of "today", which is a parameter rather
		// than a clock read inside the preset module: a preset that read the wall clock could not be
		// tested at a boundary. /transactions resolves it the same way, in its own load.
		todayIso: new Date().toISOString().slice(0, 10),
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
	// Batched (see collectAllTransactions/forEachTransactionBatch), not a plain findMany: this
	// select spreads EFFECTIVE_CATEGORY_SELECT, whose `splits` relation Prisma resolves with a
	// second query carrying one host parameter per parent row — a plain findMany 500'd on SQLite
	// once the comparison period held enough transactions. `order: 'asc'` matches this read's
	// previous `orderBy`; every downstream consumer (buildPeriodReport) sums/filters/sorts its own
	// way and does not depend on the order rows arrive in.
	const transactions = await collectAllTransactions(
		{
			userId,
			date: {
				gte: from,
				lt: to
			}
		},
		{
			id: true,
			date: true,
			label: true,
			amountCents: true,
			type: true,
			source: true,
			natureManual: true,
			...EFFECTIVE_CATEGORY_SELECT
		},
		{ order: 'asc' }
	);

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
