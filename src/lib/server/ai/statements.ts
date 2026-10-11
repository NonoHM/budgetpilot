import {
	AI_CATEGORY_ALIASES,
	AI_PERIOD_ALIAS,
	AI_STATEMENT_SCOPES,
	type AiStatementKind
} from '$lib/domain/aiStatements';
import type { CategoryBudgetSummary } from '$lib/domain/budget';
import { normalizeForMatch } from '$lib/domain/normalize';
import type { AiStatement, ModelPick, TransactionSummary } from '$lib/server/insights/types';

/**
 * WHAT THE APP ACCEPTS FROM THE MODEL (#996, replacing G3's text filters). The model returns picks:
 * a statement kind and a target, from closed lists. This file decides which picks reach the card,
 * by recomputing each fact from the SAME figures the prompt was built from; the card writes the
 * sentence. So the card can only say what the app checked, and nothing the model wrote is shown.
 *
 * The deny-list this replaces (a phrase policy, a number check, a character allow-list) never closed:
 * every contradiction pass and the literature pass of 2026-10-11 found a new spelling that passed it.
 * A pick has no spelling.
 *
 * A pure function of the answer and the facts: no clock, no locale, no network.
 */

/** A top category as the model is told about it, and as the app checks a pick against it. */
export interface CategoryFacts {
	alias: (typeof AI_CATEGORY_ALIASES)[number];
	/** The name as stored: the key of the payload, never a sentence. */
	name: string;
	amountCents: number;
	/**
	 * Its budget this period: a status, `none` when it has no budget, or `unknown` when the period is
	 * not a whole month and no budget is read at all (`dashboard/periodData.ts`). « No budget » is a
	 * claim only the first two can support (contradiction pass F1 on the design note).
	 */
	budget: CategoryBudgetSummary['status'] | 'none' | 'unknown';
	/** Whether the period's repeated-payment detection found a stream in this category. */
	recurring: boolean;
}

export interface AdviceFacts {
	categories: CategoryFacts[];
	/**
	 * Two stored spellings of one category in the period (« Courses » and « courses »): budgets sum
	 * them as one (`domain/budget.ts`), the top categories as two (`reports/monthly.ts`). Restore and
	 * the category rules store a name as written, so it happens. Then no ranking and no budget
	 * verdict about those names is shown beside a figure that counts only one of them (contradiction
	 * pass F1 on the final code).
	 */
	spellingsFold: boolean;
	incomeCents: number;
	expenseCents: number;
	/** The whole previous month's spending, when the period has one to compare with. */
	previousExpenseCents: number | null;
}

/**
 * The facts of a period, read from the summary the prompt is built from. `budgetsKnown` is
 * `budgetSummaryAvailable`: false on a period that is not a whole month. `expenseCategories` is
 * every category name the period's expenses carry, as stored, top five or not.
 */
export function adviceFacts(
	summary: TransactionSummary,
	budgets: {
		budgetsKnown: boolean;
		summaries: Pick<CategoryBudgetSummary, 'category' | 'status'>[];
		expenseCategories: string[];
	}
): AdviceFacts {
	const spellings = new Map<string, Set<string>>();
	for (const name of budgets.expenseCategories) {
		const key = normalizeForMatch(name);
		spellings.set(key, (spellings.get(key) ?? new Set()).add(name));
	}
	const folds = (key: string) => (spellings.get(key)?.size ?? 0) > 1;
	const recurring = new Set(
		summary.recurringPayments.map((payment) => normalizeForMatch(payment.category))
	);
	return {
		categories: summary.topCategories
			.slice(0, AI_CATEGORY_ALIASES.length)
			.map((category, index) => {
				const key = normalizeForMatch(category.category);
				const status = budgets.summaries.find(
					(budget) => normalizeForMatch(budget.category) === key
				)?.status;
				return {
					alias: AI_CATEGORY_ALIASES[index],
					name: category.category,
					amountCents: category.amountCents,
					budget: budgets.budgetsKnown && !folds(key) ? (status ?? 'none') : 'unknown',
					recurring: recurring.has(key)
				};
			}),
		spellingsFold: [...spellings.keys()].some(folds),
		incomeCents: summary.incomeCents,
		expenseCents: summary.expenseCents,
		previousExpenseCents: summary.previousMonth
			? summary.expenseCents - summary.previousMonth.expenseDeltaCents
			: null
	};
}

type CategoryFact = (category: CategoryFacts, facts: AdviceFacts) => boolean;
type PeriodFact = (facts: AdviceFacts) => boolean;

/**
 * THE ONE DEFINITION OF EACH FACT. A `Record` over every kind, so a kind added to
 * `domain/aiStatements.ts` without its fact stops `npm run check`.
 */
const FACTS: {
	[K in AiStatementKind]: (typeof AI_STATEMENT_SCOPES)[K] extends 'category'
		? CategoryFact
		: PeriodFact;
} = {
	// No category strictly larger: two tied at the top are both the top category. Not asserted when
	// two spellings fold together, because the ranking by stored name is not the folded one.
	top_category: (category, facts) =>
		!facts.spellingsFold &&
		facts.categories.every((other) => other.amountCents <= category.amountCents),
	no_budget: (category) => category.budget === 'none',
	over_budget: (category) => category.budget === 'over_budget',
	near_limit: (category) => category.budget === 'near_limit',
	recurring: (category) => category.recurring,
	// Month to date against the WHOLE previous month (`date-range.ts`): above it is a true fact on any
	// day, below it is not, which is why there is no « spending down » (contradiction pass F2).
	spending_up: (facts) =>
		facts.previousExpenseCents !== null &&
		facts.previousExpenseCents > 0 &&
		facts.expenseCents > facts.previousExpenseCents,
	// `income > 0`, as the rules card has it: a member who imports only a card account has no
	// income in the app, which says nothing about what they earned.
	spent_more_than_earned: (facts) =>
		facts.incomeCents > 0 && facts.expenseCents > facts.incomeCents,
	// No `income > 0` here: expenses are never negative, so below income already means income.
	spent_less_than_earned: (facts) => facts.expenseCents < facts.incomeCents
};

function holds(
	kind: AiStatementKind,
	target: ModelPick['category'],
	facts: AdviceFacts
): AiStatement | null {
	if (AI_STATEMENT_SCOPES[kind] === 'period') {
		if (target !== AI_PERIOD_ALIAS) return null;
		return (FACTS[kind] as PeriodFact)(facts)
			? { id: `${kind}-${target}`, kind, figures: [] }
			: null;
	}
	const category = facts.categories.find((candidate) => candidate.alias === target);
	if (!category || !(FACTS[kind] as CategoryFact)(category, facts)) return null;
	return {
		id: `${kind}-${target}`,
		kind,
		figures: [{ category: category.name, amountCents: category.amountCents }]
	};
}

/**
 * The statements the card may show, in the model's order, each once. A pick is dropped when its
 * target does not fit its kind, names no category, or its fact is false. Every pick dropped:
 * `null`, which the gateway answers as `response_withheld`. No pick at all is the model having
 * nothing to point out, and stays that.
 */
export function acceptPicks(picks: ModelPick[], facts: AdviceFacts): AiStatement[] | null {
	if (picks.length === 0) return [];
	const shown = new Map<string, AiStatement>();
	for (const pick of picks) {
		const statement = holds(pick.kind, pick.category, facts);
		// Keyed by id: a repeated pick keeps its first place, once.
		if (statement) shown.set(statement.id, statement);
	}
	return shown.size === 0 ? null : [...shown.values()];
}
