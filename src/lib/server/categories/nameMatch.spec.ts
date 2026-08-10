import { afterEach, describe, expect, it } from 'vitest';
import { locales, overwriteGetLocale } from '$lib/paraglide/runtime';
import * as m from '$lib/paraglide/messages';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import {
	categoriesCollide,
	categoryNameKeys,
	findCategoryByTypedName,
	isReservedCategoryName
} from './nameMatch';

/**
 * These assertions are ABSOLUTE per locale rather than comparative, and deliberately so: a test
 * that only checked "the English answer differs from the French one" would pass in a world where
 * both were wrong in the same direction. Each case names the label it expects to collide with,
 * through the message function rather than a retyped literal.
 *
 * vitest.server.setup.ts pins the locale to 'fr' for every server spec, so each test that needs
 * the other one says so, and afterEach puts the pin back.
 */
afterEach(() => {
	overwriteGetLocale(() => 'fr');
});

describe('categoryNameKeys', () => {
	it('emits one key for a category the user named themselves', () => {
		expect.assertions(1);

		// Nothing translates it, so the stored name and the displayed label are the same string
		// and a second key would be noise.
		expect(categoryNameKeys({ name: 'Mes courses', defaultKey: null })).toHaveLength(1);
	});

	it('emits the stored key and the displayed key for a seeded default', () => {
		expect.assertions(2);
		overwriteGetLocale(() => 'en');

		const keys = categoryNameKeys({ name: 'Alimentation', defaultKey: 'food' });

		expect(keys).toHaveLength(2);
		expect(keys).toEqual(
			categoryNameKeys({ name: 'Alimentation', defaultKey: null }).concat(
				categoryNameKeys({ name: m.category_default_food(), defaultKey: null })
			)
		);
	});

	it('collapses to one key in the locale the defaults were seeded in', () => {
		expect.assertions(1);

		// French stores and displays "Alimentation", which is why the defect was invisible here.
		expect(categoryNameKeys({ name: 'Alimentation', defaultKey: 'food' })).toHaveLength(1);
	});

	it('folds case and accents on both sides, the way the stored key already did', () => {
		expect.assertions(2);
		overwriteGetLocale(() => 'en');

		const keys = categoryNameKeys({ name: 'Alimentation', defaultKey: 'food' });

		expect(keys).toContain(categoryNameKeys({ name: 'alimentation' })[0]);
		expect(keys).toContain(categoryNameKeys({ name: 'GROCERIES' })[0]);
	});
});

describe('findCategoryByTypedName', () => {
	const categories = [
		{ id: 'cat-food', name: 'Alimentation', defaultKey: 'food' },
		{ id: 'cat-mine', name: 'Mes courses', defaultKey: null }
	];

	it('finds the default a typed English label belongs to', () => {
		expect.assertions(1);
		overwriteGetLocale(() => 'en');

		expect(findCategoryByTypedName(m.category_default_food(), categories)).toMatchObject({
			id: 'cat-food'
		});
	});

	it('still finds it by its stored name, which is what the unique constraint sees', () => {
		expect.assertions(1);
		overwriteGetLocale(() => 'en');

		expect(findCategoryByTypedName('Alimentation', categories)).toMatchObject({ id: 'cat-food' });
	});

	it('finds nothing for the English label in French, where nothing displays it', () => {
		expect.assertions(1);

		expect(findCategoryByTypedName(m.category_default_food({}, { locale: 'en' }), categories)).toBe(
			undefined
		);
	});

	it('matches a user-named category on its one name', () => {
		expect.assertions(1);

		expect(findCategoryByTypedName('MES COURSES', categories)).toMatchObject({ id: 'cat-mine' });
	});

	it('reaches the "to classify" pile through its translation', () => {
		expect.assertions(1);
		overwriteGetLocale(() => 'en');

		// The pile is stored as a slug and never displayed as one, so a check that only saw the
		// slug would let a real category be created wearing its label.
		expect(
			findCategoryByTypedName(m.common_category_uncategorized(), [{ name: UNCLASSIFIED_CATEGORY }])
		).toBeDefined();
	});
});

describe('isReservedCategoryName', () => {
	it('reserves the slug itself', () => {
		expect.assertions(1);

		expect(isReservedCategoryName(UNCLASSIFIED_CATEGORY)).toBe(true);
	});

	it('reserves the pile’s label in a locale the user is NOT reading', () => {
		expect.assertions(2);
		overwriteGetLocale(() => 'en');

		// Measured through the real request path: this was created before the rule spanned
		// locales, and it only becomes visible on the day the user switches language.
		expect(isReservedCategoryName(m.common_category_uncategorized({}, { locale: 'fr' }))).toBe(
			true
		);
		expect(isReservedCategoryName(m.common_category_uncategorized({}, { locale: 'en' }))).toBe(
			true
		);
	});

	it('reserves every locale the app compiles, not a hand-listed pair', () => {
		expect.assertions(locales.length);

		// Iterating `locales` is what makes a third language inherit this for free. Written as an
		// assertion rather than a comment because the alternative — two literals — is exactly what
		// a future locale would silently fail to update.
		for (const locale of locales) {
			expect(isReservedCategoryName(m.common_category_uncategorized({}, { locale }))).toBe(true);
		}
	});

	it('leaves an ordinary name alone', () => {
		expect.assertions(1);

		expect(isReservedCategoryName('Groceries')).toBe(false);
	});
});

describe('categoriesCollide', () => {
	it('is symmetric between a default and a category displaying its label', () => {
		expect.assertions(2);
		overwriteGetLocale(() => 'en');

		const seeded = { name: 'Alimentation', defaultKey: 'food' };
		const mine = { name: m.category_default_food(), defaultKey: null };

		expect(categoriesCollide(seeded, mine)).toBe(true);
		expect(categoriesCollide(mine, seeded)).toBe(true);
	});

	it('leaves two genuinely different categories apart', () => {
		expect.assertions(1);
		overwriteGetLocale(() => 'en');

		expect(
			categoriesCollide({ name: 'Alimentation', defaultKey: 'food' }, { name: 'Transport' })
		).toBe(false);
	});
});
