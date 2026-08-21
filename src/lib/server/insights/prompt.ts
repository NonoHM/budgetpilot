import { getLocale } from '$lib/paraglide/runtime';
import type { TransactionSummary } from './types';
import { money, toMajorUnitNumber } from '$lib/domain/money';

const PROMPT_CURRENCY = 'EUR';

// The advice is rendered straight into the dashboard card, so it has to come back in the
// language the rest of the page is in. The prompt used to hardcode "réponds en français",
// which left an English-locale user reading French advice under English headings.
const RESPONSE_LANGUAGES: Record<string, string> = {
	fr: 'French',
	en: 'English'
};
const DEFAULT_RESPONSE_LANGUAGE = 'English';

function buildSystemPrompt(responseLanguage: string): string {
	return `You are Budget Insights, a local budgeting assistant.
You only analyse the summarised budget data provided to you.
Give general, concrete, non-regulated advice.
Do not give investment, tax, credit, insurance or financial-product advice.
Do not make the user feel guilty.
Reply in ${responseLanguage}.
Give at most 3 to 5 pieces of advice.
Each one must be short, actionable and based on the figures provided.
If the data is insufficient, say so plainly.

All amounts are in euros (${PROMPT_CURRENCY}), already converted, with two decimals.
Use them as-is: never multiply or divide them, and never report any other currency.

Expected JSON format:
{
"summary": "short sentence",
"insights": [
{
"title": "short title",
"message": "short piece of advice",
"severity": "info | warning | critical",
"category": "budget | spending | income | recurring | anomaly"
}
]
}`;
}

/**
 * Amounts are stored and passed around as integer cents, but the model has no way to know
 * that from the JSON alone: it read `expenseCents: 151487` as a plain amount and produced
 * advice about "151487 dollars" — off by 100x and in the wrong currency.
 *
 * So the payload the model sees is converted to euros, and every key loses its `Cents`
 * suffix along with it (`expenseCents` -> `expense`) so nothing in the JSON still claims a
 * unit the values no longer use. Keyed off the suffix rather than a fixed field list on
 * purpose: any monetary field added later follows the repo's `*Cents` naming and gets
 * converted automatically instead of silently reaching the model as raw cents.
 */
export function toPromptPayload(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(toPromptPayload);
	if (value === null || typeof value !== 'object') return value;

	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
			if (key.endsWith('Cents') && typeof entry === 'number') {
				return [key.slice(0, -'Cents'.length), toMajorUnitNumber(money(Math.round(entry)))];
			}
			return [key, toPromptPayload(entry)];
		})
	);
}

// #216: this sentence is the model-facing description of what the payload contains, and it has to
// stay true to what is actually sent. When the user has NOT opted into sharing labels, the payload's
// merchant labels are anonymized to a placeholder (see summary.ts), so "no raw transactions" holds.
// When they HAVE opted in, `largestExpenses[].label` and `recurringPayments[].label` carry their real
// (title-cased, truncated) merchant text, so the sentence must say so rather than claim the opposite.
// Both variants are plain English like the rest of this prompt: they reach the model, never the UI.
const DATA_DESCRIPTION_AGGREGATED = 'Aggregated data, no raw transactions';
const DATA_DESCRIPTION_WITH_LABELS = 'Aggregated data plus your largest transaction labels';

export function buildBudgetInsightsPrompt(
	summary: TransactionSummary,
	options: { includeLabels?: boolean; locale?: string } = {}
): string {
	const locale = options.locale ?? getLocale();
	const responseLanguage = RESPONSE_LANGUAGES[locale] ?? DEFAULT_RESPONSE_LANGUAGE;
	const dataDescription = options.includeLabels
		? DATA_DESCRIPTION_WITH_LABELS
		: DATA_DESCRIPTION_AGGREGATED;

	return `${buildSystemPrompt(responseLanguage)}

${dataDescription} (amounts in ${PROMPT_CURRENCY}):
${JSON.stringify({ currency: PROMPT_CURRENCY, ...(toPromptPayload(summary) as object) })}`;
}
