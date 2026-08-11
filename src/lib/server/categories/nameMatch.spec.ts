import { afterEach, describe, expect, it } from 'vitest';
import { locales, overwriteGetLocale } from '$lib/paraglide/runtime';
import * as m from '$lib/paraglide/messages';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { findCategoryByTypedName, isReservedCategoryName } from './nameMatch';

/**
 * vitest.server.setup.ts pins the locale to 'fr' for every server spec, so each test that needs
 * the other one says so, and afterEach puts the pin back.
 */
afterEach(() => {
	overwriteGetLocale(() => 'fr');
});

describe('findCategoryByTypedName', () => {
	const categories = [
		{ id: 'cat-food', name: 'Alimentation' },
		{ id: 'cat-mine', name: 'Mes courses' }
	];

	it('matches a category on its stored name, folding case and accents', () => {
		expect.assertions(3);

		expect(findCategoryByTypedName('Alimentation', categories)).toMatchObject({ id: 'cat-food' });
		expect(findCategoryByTypedName('ALIMENTATION', categories)).toMatchObject({ id: 'cat-food' });
		expect(findCategoryByTypedName('MES COURSES', categories)).toMatchObject({ id: 'cat-mine' });
	});

	it('no longer matches a default through its translated label (#162)', () => {
		expect.assertions(1);
		overwriteGetLocale(() => 'en');

		// THE BEHAVIOUR CHANGE, asserted rather than implied. "Groceries" used to resolve to the
		// row stored as "Alimentation", because a seeded default answered to both its stored name
		// and its displayed one. It no longer displays as Groceries, so it no longer answers to
		// it, and a user is free to create a category by that name.
		expect(findCategoryByTypedName(m.category_default_food({}, { locale: 'en' }), categories)).toBe(
			undefined
		);
	});

	it('GIVES THE SAME ANSWER IN EVERY LOCALE, which is the property #162 bought', () => {
		expect.assertions(locales.length * 4);

		// The guard this whole chantier exists to make possible, and the one thing no test could
		// assert before it: whether a name is already taken is now a question about the database
		// alone. It used to depend on the language being read, so the same two rows collided or
		// did not depending on who was looking, and a user could create a duplicate simply by
		// switching language first.
		//
		// Iterating `locales` rather than naming 'fr' and 'en': a third language inherits this
		// for free, and a hand-listed pair is exactly what a future locale would fail to update.
		const probes = ['Alimentation', 'Groceries', 'Mes courses', 'Transport'];
		const answers = new Map<string, string | undefined>();

		for (const locale of locales) {
			overwriteGetLocale(() => locale);
			for (const probe of probes) {
				const found = findCategoryByTypedName(probe, categories)?.id;
				if (!answers.has(probe)) answers.set(probe, found);
				expect(found).toBe(answers.get(probe));
			}
		}
	});

	it('reaches the "to classify" pile through its slug, and in English through its label too', () => {
		expect.assertions(3);

		const pile = [{ name: UNCLASSIFIED_CATEGORY }];

		expect(findCategoryByTypedName(UNCLASSIFIED_CATEGORY, pile)).toBeDefined();

		// MEASURED, not assumed, and the first version of this test asserted the opposite. The
		// English label "Uncategorized" and the stored slug "uncategorized" differ only in case,
		// and `computeNameKey` folds case, so in English the label reaches the pile by ordinary
		// name matching. In French it does not: "Non catégorisé" folds to something else.
		//
		// That asymmetry is harmless precisely because it is not what protects the pile.
		// `isReservedCategoryName` refuses both spellings in every locale at once, so neither
		// answer here can let a second row wear the pile's name.
		overwriteGetLocale(() => 'en');
		expect(findCategoryByTypedName(m.common_category_uncategorized(), pile)).toBeDefined();

		overwriteGetLocale(() => 'fr');
		expect(findCategoryByTypedName(m.common_category_uncategorized(), pile)).toBeUndefined();
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
		// assertion rather than a comment because the alternative, two literals, is exactly what
		// a future locale would silently fail to update.
		for (const locale of locales) {
			expect(isReservedCategoryName(m.common_category_uncategorized({}, { locale }))).toBe(true);
		}
	});

	it('answers the same in every locale, being locale-COMPLETE rather than locale-DEPENDENT', () => {
		expect.assertions(locales.length * 2);

		// The distinction that survives #162, and the reason this function still iterates locales
		// while nothing else does. It does not ask what a category is CALLED in the current
		// language; it refuses a closed set of names in ALL languages at once. So switching
		// language cannot change what it permits, which was the defect everywhere else.
		for (const locale of locales) {
			overwriteGetLocale(() => locale);
			expect(isReservedCategoryName('Non catégorisé')).toBe(true);
			expect(isReservedCategoryName('Groceries')).toBe(false);
		}
	});

	it('leaves an ordinary name alone', () => {
		expect.assertions(1);

		expect(isReservedCategoryName('Groceries')).toBe(false);
	});
});
