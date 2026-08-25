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

export type { LocalLlmFailureCode };

export interface LocalLlmResult {
	summary: string;
	insights: BudgetInsight[];
	unavailable?: boolean;
	/** Set whenever `unavailable` is true, and never otherwise. */
	failureCode?: LocalLlmFailureCode;
}

/** What the dashboard needs from a local-model run — streamed, so it arrives after the page. */
export interface LocalAiAdvice {
	insights: BudgetInsight[];
	unavailable: boolean;
	failureCode?: LocalLlmFailureCode;
}

/**
 * Keys that may never appear in the payload handed to the local model, expressed as a TYPE so the
 * compiler refuses the field, and mirrored at run time by `KEYS_REFUSED_IN_PROMPT` in `prompt.ts`.
 *
 * Two halves rather than one, and the reason is a line of existing code: `buildBudgetInsightsPrompt`
 * casts the walked payload `as object`, and a cast defeats a type. So the type catches the honest
 * mistake at the moment it is written, and the run-time refusal is the one that actually holds.
 *
 * Recursive, because the walker is. `toPromptPayload` recurses to any depth, so a guard inspecting
 * only the top level would be narrower than the hole it is guarding.
 */
type ForbiddenPromptKey =
	| 'discriminant'
	| 'iban'
	| 'bban'
	| 'accountNumber'
	| 'id'
	| 'accountId'
	| 'userId'
	| 'transactionId'
	| 'importBatchId';

/** Every forbidden key reachable anywhere in `T`, as a union. `never` when there are none. */
type ForbiddenKeysIn<T> = T extends (...args: never[]) => unknown
	? never
	: T extends Date
		? never
		: T extends readonly (infer Element)[]
			? ForbiddenKeysIn<Element>
			: T extends object
				? | Extract<keyof T, ForbiddenPromptKey>
					| { [K in keyof T]-?: ForbiddenKeysIn<NonNullable<T[K]>> }[keyof T]
				: never;

/** `true` when nothing is reachable, otherwise the offending key, which is what the error names. */
export type AssertPromptSafe<T> = [ForbiddenKeysIn<T>] extends [never] ? true : ForbiddenKeysIn<T>;

/**
 * THE ASSERTION ITSELF. If a later change adds an account, an id or an account fragment to any type
 * reachable from `TransactionSummary`, this line stops compiling and names the key.
 *
 * A spending-by-account report is an obvious feature and is exactly the change that would do it,
 * which is why this exists before anyone builds one rather than after.
 */
const _transactionSummaryCarriesNoRefusedKey: AssertPromptSafe<TransactionSummary> = true;
void _transactionSummaryCarriesNoRefusedKey;
