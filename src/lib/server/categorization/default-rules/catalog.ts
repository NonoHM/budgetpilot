import { z } from 'zod';
import { DEFAULT_CATEGORY_KEYS } from '$lib/domain/categories';
import { TRANSACTION_NATURES } from '$lib/domain/transaction';
import { isSafeRegexPattern } from '$lib/server/matching/regex';
import groceriesDining from './groceries_dining.json';
import techSubscriptions from './tech_subscriptions.json';
import shoppingLeisure from './shopping_leisure.json';
import transport from './transport.json';
import housingBills from './housing_bills.json';
import banksInvestment from './banks_investment.json';
import health from './health.json';
import travel from './travel.json';

/**
 * Max length of a rule field (cf. MAX_RULE_FIELD_LENGTH in categorization/rules.ts) —
 * duplicated here rather than imported to avoid creating a dependency from rules.ts to this module.
 */
const MAX_RULE_FIELD_LENGTH = 80;

const defaultRuleEntrySchema = z.object({
	key: z.string().min(1).max(60),
	match: z.string().min(2).max(MAX_RULE_FIELD_LENGTH),
	/**
	 * What the user READS on /rules, when the match expression is not fit to be read.
	 *
	 * Optional, and absent for most of the catalogue on purpose: « leclerc » upper-cased is exactly
	 * the right name for the Leclerc rule, and 156 hand-written names would be 156 chances to
	 * disagree with the pattern beside them. It is set only where `match` is a regex, because there
	 * the derived name is the expression itself — /rules listed a rule called
	 * `\bpea\b|plan.{0,4}[ée]pargne.{0,4}actions?`.
	 */
	name: z.string().min(1).max(60).optional(),
	isRegex: z.boolean(),
	targetCategoryKey: z.enum(DEFAULT_CATEGORY_KEYS),
	targetNature: z.enum(TRANSACTION_NATURES).nullable()
});

export const defaultRuleFileSchema = z.array(defaultRuleEntrySchema);

export type DefaultRuleEntry = z.infer<typeof defaultRuleEntrySchema>;

/**
 * Catalog files, in the INTENDED seeding ORDER: ensureDefaultRulesSeeded() creates the
 * rows in this exact order (never an arbitrary directory-scan order), because
 * findMatchingCategoryRule() stops at the first matching rule (sorted by createdAt asc).
 * Order matters here: "dining_uber_eats" (groceries_dining) must precede
 * "transport_uber" (transport) so a Uber Eats transaction never falls onto the
 * generic Uber rule; likewise "subscriptions_amazon_prime" (tech_subscriptions)
 * must precede "shopping_amazon" (shopping_leisure) so an Amazon Prime
 * subscription charge never falls onto the generic Amazon shopping rule.
 */
const CATALOG_FILES: ReadonlyArray<{ source: string; entries: unknown }> = [
	{ source: 'groceries_dining.json', entries: groceriesDining },
	{ source: 'tech_subscriptions.json', entries: techSubscriptions },
	{ source: 'shopping_leisure.json', entries: shoppingLeisure },
	{ source: 'transport.json', entries: transport },
	{ source: 'housing_bills.json', entries: housingBills },
	{ source: 'banks_investment.json', entries: banksInvestment },
	{ source: 'health.json', entries: health },
	{ source: 'travel.json', entries: travel }
];

let cachedCatalog: DefaultRuleEntry[] | null = null;

/**
 * Loads + validates the predefined rule catalog (versioned JSON files, no user input).
 * A malformed file is ignored with a warning, never a throw — must never prevent the
 * app from starting. Every regex entry goes back through isSafeRegexPattern(), the same
 * defense-in-depth as a manually created rule.
 */
export function loadDefaultRuleCatalog(): DefaultRuleEntry[] {
	if (cachedCatalog) return cachedCatalog;

	const seenKeys = new Set<string>();
	const catalog: DefaultRuleEntry[] = [];

	for (const { source, entries } of CATALOG_FILES) {
		const parsed = defaultRuleFileSchema.safeParse(entries);
		if (!parsed.success) {
			console.warn(
				`[default-rules] file skipped (invalid schema): ${source}`,
				parsed.error.message
			);
			continue;
		}

		for (const entry of parsed.data) {
			if (seenKeys.has(entry.key)) {
				console.warn(`[default-rules] duplicate key skipped: ${entry.key} (${source})`);
				continue;
			}
			if (entry.isRegex && !isSafeRegexPattern(entry.match, MAX_RULE_FIELD_LENGTH)) {
				console.warn(
					`[default-rules] regex rejected (dangerous pattern): ${entry.key} (${source})`
				);
				continue;
			}
			seenKeys.add(entry.key);
			catalog.push(entry);
		}
	}

	cachedCatalog = catalog;
	return catalog;
}

/**
 * The name a seeded rule carries on /rules: the entry's own when it has one, otherwise the match
 * with its first character upper-cased.
 *
 * Lives here rather than in `defaultRules.ts` so the catalogue's spec can assert what a user will
 * read without going through Prisma. `defaultRules.ts` calls it, so the two cannot drift.
 */
export function displayNameForDefaultRule(entry: DefaultRuleEntry): string {
	return entry.name ?? entry.match.charAt(0).toUpperCase() + entry.match.slice(1);
}
