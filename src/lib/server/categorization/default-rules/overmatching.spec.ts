import { describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORIES } from '$lib/server/categories/defaults';
import { findMatchingCategoryRule } from '$lib/server/categorization/rules';
import { loadDefaultRuleCatalog, type DefaultRuleEntry } from './catalog';

/**
 * What the shipped catalogue decides about a label it was never written for.
 *
 * ## The defect this reproduces
 *
 * A blind walk of the published image imported a synthetic statement and found « BOULANGERIE
 * MERCIER » filed under **Shopping**. Nothing on that screen was wrong about the amount, the date
 * or the sign; the money was simply in the wrong budget, which is the one output a budgeting
 * application exists to produce.
 *
 * The cause is not that rule's spelling. `shopping_boulanger` names **Boulanger**, the electronics
 * retailer, and it is correct about it. The catalogue is matched with `normalizedContains`, a
 * SUBSTRING test, so a brand whose name is a prefix of a longer everyday word claims every label
 * containing that word. « Boulanger » is a prefix of « boulangerie », and a bakery is about as
 * common as a line gets on a French statement.
 *
 * ## Why the corpus, and not one assertion about bakeries
 *
 * The instance is a bakery; the PATTERN is prefix-of-a-common-word, and a fix aimed only at the
 * instance leaves the rest of the class shipping. The corpus below is one label per rule that was
 * found to over-match, each a plausible line on a real French statement, plus the labels those
 * same rules MUST still catch — because the cheap way to pass the first half is to stop matching
 * the brand at all.
 *
 * ## Resolved through the product's own resolver, at the product's own seeding order
 *
 * The rules are built from `loadDefaultRuleCatalog()` and read by `findMatchingCategoryRule`, so
 * neither the patterns nor the precedence is retyped here. Only the labels and the categories a
 * person would expect are written by hand, which is the oracle and cannot be derived from the
 * thing under test. `createMissingDefaultRules` seeds in catalogue order and the resolver stops at
 * the first match, so array order IS the priority — mirrored here by leaving the array alone.
 */

const categoryNameByKey = new Map(
	DEFAULT_CATEGORIES.map((category) => [category.key, category.name])
);

/** The catalogue as `findMatchingCategoryRule` receives it after seeding. */
function seededRules() {
	return loadDefaultRuleCatalog().map((entry: DefaultRuleEntry) => ({
		name: entry.key,
		matchText: entry.match,
		targetCategory: categoryNameByKey.get(entry.targetCategoryKey) ?? entry.targetCategoryKey,
		targetNature: entry.targetNature,
		enabled: true,
		isRegex: entry.isRegex
	}));
}

function categoryFor(label: string): string | null {
	const rule = findMatchingCategoryRule({ label, manualCategory: null }, seededRules());
	return rule?.targetCategory ?? null;
}

const FOOD = categoryNameByKey.get('food')!;
const SHOPPING = categoryNameByKey.get('shopping')!;
const TRANSPORT = categoryNameByKey.get('transport')!;
const BILLS = categoryNameByKey.get('bills_energy')!;
const DINING = categoryNameByKey.get('dining')!;

describe('a brand name that is a prefix of an everyday word does not claim that word', () => {
	/**
	 * Label, what a person would say it is, and the rule that used to claim it.
	 *
	 * `null` means « no default rule should fire »: the catalogue holds no bakery, no interior
	 * decorator and no French département, and inventing a category for them is the other way to be
	 * wrong. A rule firing on these is the defect; a rule firing on the right one is the next block.
	 */
	const OVERMATCHED: Array<[label: string, expected: string | null, claimedBy: string]> = [
		// The measured one: found on screen, in the published image, on a synthetic statement. A
		// bakery is Alimentation and the catalogue now says so, so this pair asserts the CORRECT
		// destination rather than merely the absence of the wrong one — « no rule fires » would
		// leave the user's bread uncategorised, which is a quieter way to be unhelpful.
		['CB BOULANGERIE MERCIER', FOOD, 'shopping_boulanger'],
		['PAIEMENT CB BOULANGERIE PATISSERIE DU MARCHE', FOOD, 'shopping_boulanger'],
		// « cora » sits inside « décoration », which loses its accent to the same fold that makes
		// the match accent-insensitive.
		['SARL DECORATION INTERIEURE', null, 'food_cora'],
		// « esso » sits inside « Essonne », a département whose treasury and health fund both bill
		// by name.
		['CPAM DE L ESSONNE', null, 'transport_esso'],
		// « spar » sits inside « Spartoo », a French shoe retailer the catalogue does not name.
		['SPARTOO.COM', null, 'food_spar'],
		// « orange » sits inside « orangerie », which names a great many French restaurants.
		['RESTAURANT L ORANGERIE', null, 'bills_orange']
	];

	it.each(OVERMATCHED)(
		'%s is not filed by the rule that only shares letters with it',
		(label, expected) => {
			expect(categoryFor(label)).toBe(expected);
		}
	);
});

describe('the brands those rules exist for are still caught', () => {
	/**
	 * The calibration, and it is what stops the block above being satisfied by deleting rules.
	 * Every label here is the merchant the rule was written for, spelled the way a statement spells
	 * it: bare, and with the payment chrome a bank puts around it.
	 */
	const STILL_MATCHED: Array<[label: string, expected: string]> = [
		['BOULANGER', SHOPPING],
		['CB BOULANGER LILLE', SHOPPING],
		['CORA', FOOD],
		['PAIEMENT CB CORA ARRAS', FOOD],
		['ESSO', TRANSPORT],
		['CB ESSO EXPRESS A6', TRANSPORT],
		['SPAR', FOOD],
		['CB SPAR CENTRE VILLE', FOOD],
		['ORANGE', BILLS],
		['PRLV ORANGE SA', BILLS]
	];

	it.each(STILL_MATCHED)('%s still resolves to its own category', (label, expected) => {
		expect(categoryFor(label)).toBe(expected);
	});

	it('leaves the rest of the catalogue answering as before', () => {
		// A spot check across files, so a change to the matching MECHANISM rather than to five rules
		// reddens here rather than passing both blocks above.
		expect(categoryFor('CB CARREFOUR MARKET')).toBe(FOOD);
		expect(categoryFor('UBER EATS PARIS')).toBe(DINING);
		expect(categoryFor('UBER TRIP')).toBe(TRANSPORT);
		expect(categoryFor('PRLV EDF')).toBe(BILLS);
	});
});
