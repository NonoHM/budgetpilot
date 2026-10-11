/**
 * WHAT THE AI CARD CAN SAY, as a closed list (#996). The model picks a kind and the category it is
 * about; the app shows the pick only when it recomputes the fact as true, and the card writes the
 * sentence from the catalogue. No text the model writes reaches the screen, so there is nothing for a
 * list of forbidden phrasings to catch, and nothing such a list could miss.
 *
 * Every kind is a fact the app can check from the period's own figures. A kind that is a judgement
 * (« worth reviewing ») has no such check and is not on the list.
 *
 * `category` kinds name one of the payload's top categories by its alias; `period` kinds are about
 * the period as a whole and take the alias `all`.
 */
export const AI_STATEMENT_SCOPES = {
	top_category: 'category',
	no_budget: 'category',
	over_budget: 'category',
	near_limit: 'category',
	recurring: 'category',
	spending_up: 'period',
	spent_more_than_earned: 'period',
	spent_less_than_earned: 'period'
} as const satisfies Record<string, 'category' | 'period'>;

export type AiStatementKind = keyof typeof AI_STATEMENT_SCOPES;

export const AI_STATEMENT_KINDS = Object.keys(AI_STATEMENT_SCOPES) as AiStatementKind[];

/** The payload carries at most five top categories (`reports/monthly.ts`), so five aliases. */
export const AI_CATEGORY_ALIASES = ['c1', 'c2', 'c3', 'c4', 'c5'] as const;
export const AI_PERIOD_ALIAS = 'all';
export const AI_PICK_TARGETS = [...AI_CATEGORY_ALIASES, AI_PERIOD_ALIAS] as const;
export type AiPickTarget = (typeof AI_PICK_TARGETS)[number];

/** At most three statements on the card: what a phone shows without scrolling. */
export const AI_MAX_PICKS = 3;
