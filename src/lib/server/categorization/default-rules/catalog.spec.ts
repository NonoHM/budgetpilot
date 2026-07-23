import { describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORY_KEYS } from '$lib/domain/categories';
import { isSafeRegexPattern } from '$lib/server/matching/regex';
import { loadDefaultRuleCatalog, defaultRuleFileSchema } from './catalog';

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
