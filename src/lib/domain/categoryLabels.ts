import * as m from '$lib/paraglide/messages';
import { UNCLASSIFIED_CATEGORY, type DefaultCategoryKey } from './categories';

const DEFAULT_CATEGORY_LABELS: Record<DefaultCategoryKey, () => string> = {
	food: m.category_default_food,
	dining: m.category_default_dining,
	transport: m.category_default_transport,
	housing: m.category_default_housing,
	bills_energy: m.category_default_bills_energy,
	health: m.category_default_health,
	leisure: m.category_default_leisure,
	subscriptions: m.category_default_subscriptions,
	shopping: m.category_default_shopping,
	travel: m.category_default_travel,
	income: m.category_default_income,
	savings: m.category_default_savings,
	investment: m.category_default_investment,
	other: m.category_default_other
};

/**
 * Display label for a category, in the UI's current language.
 * - "to classify" sentinel → dedicated translation (the slug is never displayed);
 * - known defaultKey → translation of the default category (name ignored);
 * - otherwise → name as-is (free-text from the user, never translated).
 */
export function categoryLabel(name: string, defaultKey?: string | null): string {
	if (name === UNCLASSIFIED_CATEGORY) return m.common_category_uncategorized();
	const resolve =
		defaultKey != null ? DEFAULT_CATEGORY_LABELS[defaultKey as DefaultCategoryKey] : undefined;
	return resolve ? resolve() : name;
}

/**
 * Variant for contexts that only work with names (budgets, reports,
 * effective category): `defaultKeyByName` is built from the categories
 * loaded for the user.
 */
export function categoryLabelByName(
	name: string,
	defaultKeyByName?: ReadonlyMap<string, string | null>
): string {
	return categoryLabel(name, defaultKeyByName?.get(name) ?? null);
}

/** Builds the name → defaultKey map expected by `categoryLabelByName`. */
export function buildDefaultKeyByName(
	categories: ReadonlyArray<{ name: string; defaultKey: string | null }>
): Map<string, string | null> {
	return new Map(categories.map((c) => [c.name, c.defaultKey]));
}
