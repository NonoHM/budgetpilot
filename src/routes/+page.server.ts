import { fail, isHttpError, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { summarizeBudgetTransactions } from '$lib/domain/budget';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import {
	createManualTransaction,
	readDashboardDataForRange,
	readDashboardData
} from '$lib/server/budget/dashboard';
import {
	getPreviousMonthRange,
	parseDateRange,
	serializePeriodParams
} from '$lib/server/date-range';
import { getBudgetInsights } from '$lib/server/insights';
import { isLocalLlmEnabled } from '$lib/server/insights/local-llm';
import { loadDashboardInsights } from '$lib/server/dashboard/insights';
import { analyzeTransactionNatures } from '$lib/server/transactions/nature';
import { readSavingsGoals } from '$lib/server/savings-goals/service';
import { loadCashFlowForecast, toDisplayCashFlowForecast } from '$lib/server/forecast';
import { getRemainingDaysInMonthUtc } from '$lib/domain/forecast';
import type { PageServerLoad } from './$types';

/** Mirrors MAX_ALERTS in server/dashboard/insights.ts — the dashboard widget stays terse. */
const MAX_DASHBOARD_GOALS = 2;

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	const period = parseDateRange(url.searchParams);
	const { transactions, budgets } = await readDashboardDataForRange(user.id, period);
	const budgetSummaryAvailable = isWholeMonthPeriod(period.from, period.to);
	const previousPeriod = getPreviousMonthRange(period);
	const previousMonthData = previousPeriod
		? await readDashboardData(user.id, previousPeriod.budgetMonth)
		: undefined;
	const summary = summarizeBudgetTransactions(
		transactions,
		budgetSummaryAvailable ? budgets : [],
		period.label
	);
	const previousSummary =
		previousMonthData &&
		(previousMonthData.transactions.length > 0 || previousMonthData.budgets.length > 0)
			? summarizeBudgetTransactions(
					previousMonthData.transactions,
					previousMonthData.budgets,
					previousPeriod?.label ?? m.dashboard_previous_period_fallback()
				)
			: undefined;
	const [aiPreferences, insights, categories, savingsGoals, cashFlowForecast] = await Promise.all([
		prisma.user.findUniqueOrThrow({
			where: { id: user.id },
			select: { aiInsightsEnabled: true, aiIncludeLabels: true }
		}),
		loadDashboardInsights(user.id),
		prisma.category.findMany({
			where: { userId: user.id },
			orderBy: { name: 'asc' },
			select: { name: true, defaultKey: true }
		}),
		readSavingsGoals(user.id),
		loadCashFlowForecast(user.id, getRemainingDaysInMonthUtc(new Date())).then(
			toDisplayCashFlowForecast
		)
	]);
	const aiAllowed = isLocalLlmEnabled(process.env) && aiPreferences.aiInsightsEnabled;
	const budgetInsights = aiAllowed
		? await getBudgetInsights({
				transactions,
				monthlySummary: summary,
				previousMonth: previousSummary,
				env: process.env,
				includeLabels: aiPreferences.aiIncludeLabels
			})
		: null;

	return {
		categoryOptions: categories.map((c) => c.name),
		categories,
		month: period.budgetMonth,
		period,
		budgetSummaryAvailable,
		periodQuery: serializePeriodParams(period),
		transactions,
		budgets,
		summary,
		natureAnalysis: analyzeTransactionNatures(transactions),
		advice: budgetInsights?.insights ?? null,
		localAiUnavailable: budgetInsights?.localAiUnavailable ?? false,
		aiAllowed,
		recentTransactions: transactions.slice(0, 10),
		insights,
		savingsGoals: savingsGoals.slice(0, MAX_DASHBOARD_GOALS),
		savingsGoalsOverflowCount: Math.max(0, savingsGoals.length - MAX_DASHBOARD_GOALS),
		cashFlowForecast
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
	if (isHttpError(caught)) return caught.body.message;
	return caught instanceof Error ? caught.message : m.dashboard_error_generic();
}

function isWholeMonthPeriod(from: Date, to: Date): boolean {
	const nextMonthStart = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
	return (
		from.getUTCDate() === 1 &&
		to.getUTCDate() === 1 &&
		to.getUTCFullYear() === nextMonthStart.getUTCFullYear() &&
		to.getUTCMonth() === nextMonthStart.getUTCMonth()
	);
}
