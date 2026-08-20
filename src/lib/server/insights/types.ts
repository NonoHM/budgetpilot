import type {
	AnonymizedExpense,
	CategoryTotal,
	MonthlyReportComparison,
	RecurringPayment
} from '$lib/server/reports/monthly';

export type InsightSeverity = 'info' | 'warning' | 'critical';

export type InsightCategory = 'budget' | 'spending' | 'income' | 'recurring' | 'anomaly';

export interface BudgetInsight {
	id: string;
	title: string;
	message: string;
	severity: InsightSeverity;
	category: InsightCategory;
	source: 'rules' | 'local-llm';
}

export interface FlaggedCategoryLabels {
	category: string;
	labels: string[];
}

export interface TransactionSummary {
	period: string;
	incomeCents: number;
	expenseCents: number;
	balanceCents: number;
	transactionCount: number;
	topCategories: CategoryTotal[];
	largestExpenses: AnonymizedExpense[];
	/**
	 * `Omit<..., 'id'>`, and the omission is a control rather than tidiness. `RecurringPayment.id`
	 * is the stream's most recent TRANSACTION id, added so /reports can key an `#each` on something
	 * unique. This payload is handed to the local model, and the prompt declares it as "Aggregated
	 * data, no raw transactions" when the user has not opted into sharing labels (see #216's comment
	 * in prompt.ts) — a raw transaction identifier makes that sentence false.
	 *
	 * ASVS 5.0.0 `v5.0.0-14.2.3` (L2): "Verify that defined sensitive data is not sent to untrusted
	 * parties (e.g., user trackers) to prevent unwanted collection of data outside of the
	 * application's control."
	 *
	 * Typed here rather than only stripped at the call site, so the compiler is what refuses the
	 * field. It arrived through a `...payment` SPREAD rather than through an edit, which is a shape
	 * no reviewer catches by reading the diff.
	 */
	recurringPayments: Omit<RecurringPayment, 'id'>[];
	previousMonth?: MonthlyReportComparison;
	flaggedCategoryLabels?: FlaggedCategoryLabels[];
}

export interface LocalLlmResult {
	summary: string;
	insights: BudgetInsight[];
	unavailable?: boolean;
}

/** What the dashboard needs from a local-model run — streamed, so it arrives after the page. */
export interface LocalAiAdvice {
	insights: BudgetInsight[];
	unavailable: boolean;
}
