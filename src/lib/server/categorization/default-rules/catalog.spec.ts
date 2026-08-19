import { describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORY_KEYS } from '$lib/domain/categories';
import { isSafeRegexPattern } from '$lib/server/matching/regex';
import {
	loadDefaultRuleCatalog,
	defaultRuleFileSchema,
	displayNameForDefaultRule
} from './catalog';

describe('loadDefaultRuleCatalog', () => {
	it('charge un catalogue non vide avec des clés uniques', () => {
		expect.assertions(2);

		const catalog = loadDefaultRuleCatalog();
		const keys = catalog.map((e) => e.key);

		expect(catalog.length).toBeGreaterThan(0);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('chaque targetCategoryKey référence une clé de catégorie par défaut existante', () => {
		expect.assertions(1);

		const catalog = loadDefaultRuleCatalog();
		const invalid = catalog.filter(
			(e) => !(DEFAULT_CATEGORY_KEYS as readonly string[]).includes(e.targetCategoryKey)
		);

		expect(invalid).toEqual([]);
	});

	it('toute entrée isRegex passe isSafeRegexPattern (défense en profondeur même sur du contenu versionné)', () => {
		expect.assertions(1);

		const catalog = loadDefaultRuleCatalog();
		const unsafeRegexEntries = catalog.filter((e) => e.isRegex && !isSafeRegexPattern(e.match, 80));

		expect(unsafeRegexEntries).toEqual([]);
	});

	it('la règle "Uber Eats" précède la règle générique "Uber" (ordre du catalogue = priorité de matching)', () => {
		expect.assertions(1);

		const catalog = loadDefaultRuleCatalog();
		const uberEatsIndex = catalog.findIndex((e) => e.key === 'dining_uber_eats');
		const uberIndex = catalog.findIndex((e) => e.key === 'transport_uber');

		expect(uberEatsIndex).toBeLessThan(uberIndex);
	});

	it('est mis en cache (deux appels renvoient la même référence)', () => {
		expect.assertions(1);

		expect(loadDefaultRuleCatalog()).toBe(loadDefaultRuleCatalog());
	});
});

describe('defaultRuleFileSchema', () => {
	it('rejette un targetCategoryKey qui ne fait pas partie des catégories par défaut', () => {
		expect.assertions(1);

		const result = defaultRuleFileSchema.safeParse([
			{
				key: 'x',
				match: 'foo',
				isRegex: false,
				targetCategoryKey: 'not_a_real_key',
				targetNature: null
			}
		]);

		expect(result.success).toBe(false);
	});

	it('rejette un match trop court', () => {
		expect.assertions(1);

		const result = defaultRuleFileSchema.safeParse([
			{ key: 'x', match: 'a', isRegex: false, targetCategoryKey: 'food', targetNature: null }
		]);

		expect(result.success).toBe(false);
	});

	it('accepte une entrée valide avec targetNature null', () => {
		expect.assertions(1);

		const result = defaultRuleFileSchema.safeParse([
			{ key: 'x', match: 'leclerc', isRegex: false, targetCategoryKey: 'food', targetNature: null }
		]);

		expect(result.success).toBe(true);
	});
});

/**
 * What the user READS on /rules for a predefined rule.
 *
 * A catalogue entry's `match` is a matching expression, and `deriveRuleName` was building the
 * displayed name out of it by upper-casing the first character. For a plain brand that is exactly
 * right — « leclerc » becomes « Leclerc ». For a regex entry it produces the expression itself, so
 * /rules listed rules called « \bpea\b|plan.{0,4}[ée]pargne.{0,4}actions? » and « Domino's|dominos ».
 *
 * That was already true of eleven entries before the over-matching fix, and converting five brand
 * rules to word-boundary patterns would have made it sixteen — which is what turned a wart into
 * something worth closing rather than inheriting.
 *
 * The assertion is on the metacharacters rather than on a list of expected names: a list would be
 * this test retyping the catalogue, and would go red on every entry added rather than on the
 * property being broken.
 */
describe('a predefined rule is named for a person to read, never for a matcher', () => {
	it('shows no regex syntax in any seeded name', () => {
		expect.assertions(1);

		const offenders = loadDefaultRuleCatalog()
			.map((entry) => ({ key: entry.key, name: displayNameForDefaultRule(entry) }))
			// `+` is deliberately NOT in this class. It is a regex quantifier and it is also a
			// character in real brand names — Canal+, Disney+ — so flagging it would force the
			// catalogue to misspell a brand to satisfy a test about spelling brands.
			.filter(({ name }) => /[\\|(){}[\]*?^$]/.test(name));

		expect(offenders).toEqual([]);
	});

	it('still derives a name for the plain entries, which are most of them', () => {
		// The calibration: satisfying the test above by giving every entry an explicit name would be
		// 156 hand-written strings, and dropping the derivation would leave them all unnamed.
		expect.assertions(2);

		const catalog = loadDefaultRuleCatalog();
		const derived = catalog.filter((entry) => !entry.name);

		expect(derived.length).toBeGreaterThan(100);
		expect(displayNameForDefaultRule(derived.find((entry) => entry.key === 'food_leclerc')!)).toBe(
			'Leclerc'
		);
	});
});
