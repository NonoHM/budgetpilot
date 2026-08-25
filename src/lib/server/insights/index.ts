import type { MonthlyBudgetSummary } from '$lib/domain/budget';
import type { Transaction } from '$lib/domain/transaction';
import type { CategoryAllocation } from '$lib/domain/allocation';
import { requestLocalBudgetInsights } from './local-llm';
import { buildBudgetInsightsPrompt } from './prompt';
import { generateRuleInsights } from './rules';
import { buildTransactionSummary } from './summary';
import type { BudgetInsight, LocalLlmFailureCode, TransactionSummary } from './types';

export interface BudgetInsightsResult {
	summary: TransactionSummary;
	insights: BudgetInsight[];
	localAiUnavailable: boolean;
	/**
	 * WHY the model produced nothing, carried alongside the boolean rather than replacing it (#524).
	 *
	 * Set exactly when `localAiUnavailable` is true. Kept as a separate field because the boolean is
	 * what decides whether a card renders at all, and the code is what decides which sentence it
	 * carries: collapsing them into one nullable field would make every reader of the first question
	 * answer the second one too.
	 */
	localAiFailureCode?: LocalLlmFailureCode;
}

export async function getBudgetInsights(params: {
	transactions: Transaction[];
	allocations: CategoryAllocation[];
	monthlySummary: MonthlyBudgetSummary;
	previousMonth?: MonthlyBudgetSummary;
	env?: NodeJS.ProcessEnv;
	includeLabels?: boolean;
}): Promise<BudgetInsightsResult> {
	const transactionSummary = buildTransactionSummary(
		params.transactions,
		params.allocations,
		params.monthlySummary,
		params.previousMonth,
		{ includeLabels: params.includeLabels }
	);
	const ruleInsights = generateRuleInsights(params.monthlySummary, transactionSummary);
	const prompt = buildBudgetInsightsPrompt(transactionSummary, {
		includeLabels: params.includeLabels
	});
	const llmResult = await requestLocalBudgetInsights(prompt, params.env);

	return {
		summary: transactionSummary,
		insights: [...ruleInsights, ...(llmResult?.insights ?? [])],
		localAiUnavailable: llmResult?.unavailable === true,
		...(llmResult?.failureCode ? { localAiFailureCode: llmResult.failureCode } : {})
	};
}
