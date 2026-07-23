import type { MonthlyBudgetSummary } from '$lib/domain/budget';
import type { Transaction } from '$lib/domain/transaction';
import { requestLocalBudgetInsights } from './local-llm';
import { buildBudgetInsightsPrompt } from './prompt';
import { generateRuleInsights } from './rules';
import { buildTransactionSummary } from './summary';
import type { BudgetInsight, TransactionSummary } from './types';

export interface BudgetInsightsResult {
	summary: TransactionSummary;
	insights: BudgetInsight[];
	localAiUnavailable: boolean;
}

export async function getBudgetInsights(params: {
	transactions: Transaction[];
	monthlySummary: MonthlyBudgetSummary;
	previousMonth?: MonthlyBudgetSummary;
	env?: NodeJS.ProcessEnv;
	includeLabels?: boolean;
}): Promise<BudgetInsightsResult> {
	const transactionSummary = buildTransactionSummary(
		params.transactions,
		params.monthlySummary,
		params.previousMonth,
		{ includeLabels: params.includeLabels }
	);
	const ruleInsights = generateRuleInsights(params.monthlySummary, transactionSummary);
	const prompt = buildBudgetInsightsPrompt(transactionSummary);
	const llmResult = await requestLocalBudgetInsights(prompt, params.env);

	return {
		summary: transactionSummary,
		insights: [...ruleInsights, ...(llmResult?.insights ?? [])],
		localAiUnavailable: llmResult?.unavailable === true
	};
}
