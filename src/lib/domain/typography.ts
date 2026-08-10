import { getLocale } from '$lib/paraglide/runtime';

/**
 * Locale-aware punctuation for values built in MARKUP rather than in a message.
 *
 * Both of these existed as hand-typed French spacing in Svelte templates, and the reason nobody
 * caught it is worth keeping: the message catalogues were CLEAN. A reviewer grepping
 * `messages/en.json` for a space before a colon finds nothing, because the space was never in a
 * message — it was in the template, between an interpolation and a literal, where no
 * localisation ever reaches it. English rendered « 86 % » and « Estimated balance on Aug 31 :
 * €3,456.01 », the second of which was on the README's headline screenshot.
 *
 * So the rule these two helpers exist to enforce: **punctuation that differs between locales is
 * a localisation concern even when it is one character**, and it belongs behind a function that
 * knows the locale, never beside an interpolation in a template.
 */

/**
 * French puts a space before `:`, `?`, `!` and `%`; English does not. The set is keyed by base
 * language, so a regional tag like `fr-CA` resolves the same way as `fr`.
 *
 * Adding a locale to the app means asking whether it belongs here. That is one more touchpoint
 * on top of the four `CLAUDE.md` already records, and unlike those it fails silently: a missing
 * entry renders English spacing, which looks deliberate.
 */
const SPACE_BEFORE_PUNCTUATION = new Set(['fr']);

function wantsSpace(locale: string): boolean {
	return SPACE_BEFORE_PUNCTUATION.has(locale.split('-')[0]);
}

/**
 * Formats a whole-number percentage. Delegates the separator to `Intl` rather than concatenating
 * one, so French gets its narrow no-break space (U+202F) and English gets none — and neither is
 * a decision this file makes.
 *
 * Takes the number as a percentage already (86, not 0.86), because every call site had already
 * rounded to a whole percent before this existed and re-deriving the fraction would only invite
 * a rounding difference between the old output and the new.
 */
export function formatPercent(percent: number, locale = getLocale()): string {
	return new Intl.NumberFormat(locale, {
		style: 'percent',
		maximumFractionDigits: 0
	}).format(percent / 100);
}

/**
 * Joins a label to its value with a colon, spaced the way the locale wants.
 *
 * Used for the composed strings that are not worth a message key of their own — a chart
 * segment's accessible name, a KPI's trailing figure — where the alternative is a literal `: `
 * in a template and therefore one spacing for every language.
 */
export function labelledValue(label: string, value: string, locale = getLocale()): string {
	return wantsSpace(locale) ? `${label} : ${value}` : `${label}: ${value}`;
}
