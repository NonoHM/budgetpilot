import type { AiPickTarget, AiStatementKind } from '$lib/domain/aiStatements';
import type { LocalLlmFailureCode } from '$lib/domain/failureCodes';
import type {
	AnonymizedExpense,
	CategoryTotal,
	MonthlyReportComparison,
	RecurringPayment
} from '$lib/server/reports/monthly';

export type InsightSeverity = 'info' | 'warning' | 'critical';

export type InsightCategory = 'budget' | 'spending' | 'income' | 'recurring' | 'anomaly';

/** A figure the app attaches beside an AI statement, from the payload (G3, #831). */
export interface AttachedFigure {
	/** The category's name as stored: the card shows it through `categoryDisplayName`, in `<bdi>`. */
	category: string;
	amountCents: number;
}

/** One pick of the model, as its answer carries it: a kind and a target, never words (#996). */
export interface ModelPick {
	kind: AiStatementKind;
	category: AiPickTarget;
}

/**
 * One statement of the AI card: a kind the app checked as true, and the figure of the category it is
 * about. The card writes the sentence from the kind (#996), so no string here came from the model.
 */
export interface AiStatement {
	/** `<kind>-<alias>`: unique on a card, because a repeated pick is kept once. */
	id: string;
	kind: AiStatementKind;
	figures: AttachedFigure[];
}

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
	picks: ModelPick[];
	unavailable?: boolean;
	/** Set whenever `unavailable` is true, and never otherwise. */
	failureCode?: LocalLlmFailureCode;
	/**
	 * The model did no work for this failure: the probe refused, or Ollama answered 404 or 503 before
	 * generating. Set only where that is known, never inferred from `failureCode`, because
	 * `unreachable` is also the catch-all after a generation the GPU did work on (#535). The gateway
	 * refunds the member's quota on it; it never reaches the page.
	 */
	notCharged?: true;
}

/** What the dashboard needs from a local-model run — streamed, so it arrives after the page. */
export interface LocalAiAdvice {
	statements: AiStatement[];
	unavailable: boolean;
	failureCode?: LocalLlmFailureCode;
	/** With `quota_reached` only: whole minutes until this member may start again, at least 1. */
	retryInMinutes?: number;
	/** Nobody is waiting for this answer (a newer request, an opt-out): the card goes back to idle. */
	cancelled?: true;
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
