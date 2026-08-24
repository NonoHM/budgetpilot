import { getLocale } from '$lib/paraglide/runtime';
import type { TransactionSummary } from './types';
import { DEFAULT_CURRENCY, money, toMajorUnitNumber } from '$lib/domain/money';

/**
 * The currency the prompt tells the model the figures are in.
 *
 * The application default rather than a literal, and this is now the ONLY thing standing between
 * this prompt and a per-row currency: every transaction carries `currency` and `exponent`, so a
 * multi-currency dashboard replaces this constant with a read and nothing else here changes. Left
 * as the default deliberately: a prompt that mixed currencies without saying so would hand the
 * model figures it cannot compare, and refusing cross-currency aggregation is the design's
 * load-bearing refusal. See docs/audits/2026-08-21-stored-forms-design.md, Part B.
 */
const PROMPT_CURRENCY = DEFAULT_CURRENCY;

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
/**
 * Keys that may never appear anywhere in the payload handed to the local model.
 *
 * ## Why a refusal exists at all, when nothing in the payload carries these today
 *
 * MEASURED 2026-08-22: no account-shaped object is in `TransactionSummary`, and a search of this
 * whole module for `account|bucket|institution|discriminant` returns zero lines. So the fragment
 * cannot reach the model today. **But the walker below allows everything**: it recurses into every
 * array and object and passes every key through, transforming only `*Cents`. There is no allowlist
 * and no denylist, so the protection is an ABSENCE rather than a control, and an absence holds only
 * until someone adds a field. A spending-by-account report is an obvious feature, and
 * `reports/monthly.ts` already documents that a nested field reaches this prompt automatically.
 *
 * This repository has the identical shape on record one field over: `RecurringPayment.id` reached
 * the prompt through a `...payment` SPREAD rather than through an edit, which is « a shape no
 * reviewer catches by reading the diff » (see `types.ts`). The fix there was type level, so the
 * compiler refuses the field. This is that fix made to hold at run time as well, because
 * `buildBudgetInsightsPrompt` already casts the walked payload `as object` and a cast defeats a
 * type.
 *
 * ## What is on the list, and why each
 *
 * `discriminant` is the new sensitive data class: at most four characters from the end of an IBAN
 * or account number. In a list of one holder's accounts it is precisely the attribute that
 * identifies. ASVS 5.0.0 14.1.1 classifies it and 16.2.5 is the logging interdict.
 *
 * `iban`, `bban` and `accountNumber` are the fuller forms it is a fragment OF. If one of those ever
 * reaches this payload, the four-character rule is already moot.
 *
 * The identifier keys are the recorded incident rather than a precaution. The prompt declares
 * itself as « Aggregated data, no raw transactions » when the user has not opted into sharing
 * labels, and a raw identifier makes that sentence false.
 */
const KEYS_REFUSED_IN_PROMPT = new Set([
	'discriminant',
	'iban',
	'bban',
	'accountNumber',
	'id',
	'accountId',
	'userId',
	'transactionId',
	'importBatchId'
]);

export function toPromptPayload(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(toPromptPayload);
	if (value === null || typeof value !== 'object') return value;

	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
			// Checked HERE rather than in a second walker, so the rule cannot drift from the
			// traversal it constrains: whatever this function reaches, this refusal reaches.
			//
			// The KEY is named so a developer can find the field. The VALUE is never named: an
			// error message travels, through a log line, a screenshot, a ticket and a clipboard,
			// and naming the value would make the refusal itself the leak. ASVS 5.0.0 16.2.5.
			if (KEYS_REFUSED_IN_PROMPT.has(key)) {
				throw new Error(
					`[insights] refusing to build a prompt: the payload carries "${key}", which may never reach the local model. See KEYS_REFUSED_IN_PROMPT.`
				);
			}
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
