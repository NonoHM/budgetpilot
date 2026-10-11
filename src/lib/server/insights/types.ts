import type { LocalLlmFailureCode } from '$lib/domain/failureCodes';
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
	source: 'rules';
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
	 * `Omit<..., 'id'>`: `RecurringPayment.id` is a transaction id, and this summary was built to be
	 * handed to a model as aggregated data (removed in #1010; ASVS 5.0.0 `v5.0.0-14.2.3`).
	 */
	recurringPayments: Omit<RecurringPayment, 'id'>[];
	previousMonth?: MonthlyReportComparison;
	flaggedCategoryLabels?: FlaggedCategoryLabels[];
}

export type { LocalLlmFailureCode };

/**
 * What the transport returns: the answer, already validated against the caller's schema, or why
 * there is none. `null` from the transport means the connection is switched off (`LLM_ENABLED`).
 */
export type LocalLlmResult<T> =
	| { value: T; unavailable?: undefined; failureCode?: undefined; notCharged?: undefined }
	| {
			value?: undefined;
			unavailable: true;
			failureCode: LocalLlmFailureCode;
			/**
			 * The model did no work for this failure: the probe refused, or Ollama answered 404 or 503
			 * before generating. Set only where that is known, never inferred from `failureCode`,
			 * because `unreachable` is also the catch-all after a generation the GPU did work on
			 * (#535). A caller that charges a quota refunds on it.
			 */
			notCharged?: true;
	  };
