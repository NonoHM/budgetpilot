import { userFacingErrorMessage } from '$lib/server/errors';
import { fail, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { splitIndicatorsByTransactionId } from '$lib/domain/allocation';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { createManualTransaction, readAccountTransactionSpan } from '$lib/server/budget/dashboard';
import { parseDateRange, serializePeriodParams } from '$lib/server/date-range';
import { prepareAdvice } from '$lib/server/ai/gateway';
import { readDashboardPeriodData } from '$lib/server/dashboard/periodData';
import { isLocalLlmEnabled } from '$lib/server/insights/local-llm';
import { loadDashboardInsights } from '$lib/server/dashboard/insights';
import { analyzeTransactionNatures } from '$lib/server/transactions/nature';
import { readSavingsGoals } from '$lib/server/savings-goals/service';
import { loadCashFlowForecast, toDisplayCashFlowForecast } from '$lib/server/forecast';
import { getRemainingDaysInMonthUtc } from '$lib/domain/forecast';
import { loadUpcomingBillsWidget } from '$lib/server/upcoming-bills/service';
import type { PageServerLoad } from './$types';

/** Mirrors MAX_ALERTS in server/dashboard/insights.ts — the dashboard widget stays terse. */
const MAX_DASHBOARD_GOALS = 2;

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	const period = parseDateRange(url.searchParams);
	const periodData = await readDashboardPeriodData(user.id, period);
	const { transactions, allocations, budgets, summary, budgetSummaryAvailable } = periodData;
	const [
		aiPreferences,
		insights,
		categories,
		savingsGoals,
		cashFlowForecast,
		upcomingBills,
		accountSpan
	] = await Promise.all([
		prisma.user.findUniqueOrThrow({
			where: { id: user.id },
			select: { aiInsightsEnabled: true, aiIncludeLabels: true }
		}),
		loadDashboardInsights(user.id),
		prisma.category.findMany({
			where: { userId: user.id },
			orderBy: { name: 'asc' },
			select: { name: true }
		}),
		readSavingsGoals(user.id),
		loadCashFlowForecast(user.id, getRemainingDaysInMonthUtc(new Date())).then(
			toDisplayCashFlowForecast
		),
		// Its OWN `readDashboardDataForRange` over a 12-month lookback — the widget does NOT ride
		// the forecast's query, as the plan's note S3 claimed. This is the third independent
		// full-year transaction read of a dashboard load. All three run concurrently here, so
		// latency and correctness are unaffected; the sharing simply does not exist, and a future
		// consolidation starts by knowing that.
		loadUpcomingBillsWidget(user.id),
		// UNCONDITIONAL, and that is the decision worth defending rather than re-deriving: it
		// joins six already-concurrent queries here at no serial cost, whereas running it only
		// when the period turned out empty would add a second round trip to exactly the case
		// that needs it. Nothing else on this payload can answer "does this account have any
		// transactions at all" — every other read is period-scoped or lookback-scoped.
		readAccountTransactionSpan(user.id)
	]);
	const aiAllowed = isLocalLlmEnabled(process.env) && aiPreferences.aiInsightsEnabled;
	// #535: the load starts NO generation. It ran on every load, hover prefetches included, with
	// nothing bounding how many ran at once (a hover spent 9.7 s of GPU). It returns the key of the
	// advice instead, and the card posts to `/insights/advice` whenever the key changes, so a new
	// period or a new transaction refreshes the advice and a reload of unchanged data is a cache hit.
	const aiAdviceKey = aiAllowed ? adviceKeyOrNull(periodData, aiPreferences.aiIncludeLabels) : null;
	// Computed once over the period's allocations, not per row: `recentTransactions` only ever
	// looks up the first 10, but the map itself is built from the whole set exactly once.
	const recentSplitIndicators = splitIndicatorsByTransactionId(allocations);

	return {
		// The Periode panel's presets are a pure function of "today", which is a parameter rather
		// than a clock read inside the preset module: a preset that read the wall clock could not be
		// tested at a boundary. /transactions resolves it the same way, in its own load.
		todayIso: new Date().toISOString().slice(0, 10),
		categoryOptions: categories.map((c) => c.name),
		month: period.budgetMonth,
		period,
		budgetSummaryAvailable,
		periodQuery: serializePeriodParams(period),
		transactions,
		budgets,
		summary,
		natureAnalysis: analyzeTransactionNatures(allocations),
		aiAllowed,
		aiAdviceKey,
		// Parent-shaped, like the identity view it's sliced from — never re-ranked or relabelled
		// from a répartition's parts (same OD-3 posture as reports/monthly.ts's largestExpenses).
		// `splitIndicator` only flags that a répartition exists; `null` for an unsplit row.
		recentTransactions: transactions.slice(0, 10).map((transaction) => ({
			...transaction,
			splitIndicator: recentSplitIndicators.get(transaction.id) ?? null
		})),
		insights,
		savingsGoals: savingsGoals.slice(0, MAX_DASHBOARD_GOALS),
		savingsGoalsOverflowCount: Math.max(0, savingsGoals.length - MAX_DASHBOARD_GOALS),
		cashFlowForecast,
		upcomingBills,
		accountSpan
	};
};

export const actions: Actions = {
	createTransaction: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();

		try {
			await createManualTransaction(user.id, {
				date: getFormValue(formData, 'date'),
				label: getFormValue(formData, 'label'),
				amount: getFormValue(formData, 'amount'),
				category: getFormValue(formData, 'category')
			});
		} catch (caught) {
			return fail(400, { createTransactionError: getErrorMessage(caught) });
		}

		return { createTransactionSuccess: true };
	}
};

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}

function getErrorMessage(caught: unknown): string {
	return userFacingErrorMessage(caught, m.dashboard_error_generic());
}

/**
 * `null` when the advice cannot be prepared (a refused key in the payload). That used to be caught
 * together with the streamed generation; uncaught here it would take the whole dashboard down, and
 * the card simply shows nothing. The endpoint prepares the same advice and fails the same way.
 */
function adviceKeyOrNull(
	periodData: Awaited<ReturnType<typeof readDashboardPeriodData>>,
	includeLabels: boolean
): string | null {
	try {
		return prepareAdvice({ periodData, includeLabels }).key;
	} catch {
		return null;
	}
}
