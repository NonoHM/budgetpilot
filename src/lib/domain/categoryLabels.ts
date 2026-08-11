import * as m from '$lib/paraglide/messages';
import { UNCLASSIFIED_CATEGORY, type DefaultCategoryKey } from './categories';

/**
 * The fourteen default categories' names in the UI's language.
 *
 * NO LONGER A DISPLAY PATH, and that is the whole of #162. A category's stored `name` is now the
 * name: the app shows it as-is, sorts on it, compares it and joins on it, with no second name
 * living in a translation. What survives here is the SUGGESTION side of that: these strings are
 * what `/categories` offers to rename the fourteen seeded rows to, once, in the language the user
 * is actually reading.
 *
 * So this table is read by the rename prompt and by nothing else. If that prompt is ever removed,
 * this table and its fourteen `category_default_*` catalogue keys go with it: they would then have
 * no reader at all, and a catalogue entry nothing reads is a translation cost with no product.
 */
export const DEFAULT_CATEGORY_LABELS: Record<DefaultCategoryKey, () => string> = {
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
 * What to show for a category name.
 *
 * ONE rule, where there used to be two: the stored name, as-is, unless it is the "to classify"
 * sentinel. Everything a user typed, everything an import created and all fourteen seeded
 * categories go through the same line.
 *
 * ## Why the sentinel is still translated, and why this function survived #162 at all
 *
 * `UNCLASSIFIED_CATEGORY` is not a name, it is the technical slug `uncategorized` (see
 * domain/categories.ts). It is stored so that "unclassified" is a real row a transaction can point
 * at, and it must never reach a screen: an English user seeing "uncategorized" in a list of
 * otherwise ordinary category names would read it as somebody's badly-typed category.
 *
 * That is a different mechanism from the one #162 removes. The old `defaultKey` translation said
 * "this row's stored name is not the name", which was a second identity for an ordinary category
 * and is gone. This says "this row is not a category", which is still true. Deleting this function
 * along with the rest, as the issue's own deletion list proposed, would have put the raw slug on
 * six screens.
 *
 * It takes no `defaultKey` and never will. The single argument is the point: there is no second
 * thing a caller could pass that would change the answer.
 */
export function categoryDisplayName(name: string): string {
	return name === UNCLASSIFIED_CATEGORY ? m.common_category_uncategorized() : name;
}
