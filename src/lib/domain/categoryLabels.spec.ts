import { describe, expect, it } from 'vitest';
import * as m from '$lib/paraglide/messages';
import { UNCLASSIFIED_CATEGORY } from './categories';
import { buildDefaultKeyByName, categoryLabel, categoryLabelByName } from './categoryLabels';

describe('categoryLabel', () => {
	it('traduit le sentinel "à classer" au lieu d’afficher le slug technique', () => {
		expect.assertions(2);

		const label = categoryLabel(UNCLASSIFIED_CATEGORY);

		expect(label).toBe(m.common_category_uncategorized());
		expect(label).not.toBe(UNCLASSIFIED_CATEGORY);
	});

	it('ignore le name stocké quand un defaultKey connu est fourni', () => {
		expect.assertions(2);

		const label = categoryLabel('Nom historique périmé', 'food');

		expect(label).toBe(m.category_default_food());
		expect(label).not.toBe('Nom historique périmé');
	});

	it('retombe sur le name tel quel quand defaultKey est null (catégorie renommée par l’utilisateur)', () => {
		expect.assertions(1);

		expect(categoryLabel('Mes courses', null)).toBe('Mes courses');
	});

	it('retombe sur le name tel quel quand defaultKey est absent', () => {
		expect.assertions(1);

		expect(categoryLabel('Catégorie perso')).toBe('Catégorie perso');
	});

	it('retombe sur le name tel quel quand defaultKey est inconnu/invalide', () => {
		expect.assertions(1);

		expect(categoryLabel('Catégorie perso', 'not-a-real-key')).toBe('Catégorie perso');
	});

	it('donne la priorité au sentinel même si un defaultKey (invalide) est fourni', () => {
		expect.assertions(1);

		expect(categoryLabel(UNCLASSIFIED_CATEGORY, 'food')).toBe(m.common_category_uncategorized());
	});
});

describe('categoryLabelByName', () => {
	it('résout le defaultKey depuis la map name → defaultKey', () => {
		expect.assertions(1);

		const map = buildDefaultKeyByName([
			{ name: 'Alimentation', defaultKey: 'food' },
			{ name: 'Mes courses perso', defaultKey: null }
		]);

		expect(categoryLabelByName('Alimentation', map)).toBe(m.category_default_food());
	});

	it('retombe sur le name pour une catégorie renommée (defaultKey null dans la map)', () => {
		expect.assertions(1);

		const map = buildDefaultKeyByName([{ name: 'Mes courses perso', defaultKey: null }]);

		expect(categoryLabelByName('Mes courses perso', map)).toBe('Mes courses perso');
	});

	it('retombe sur le name quand la map ne contient pas la catégorie', () => {
		expect.assertions(1);

		expect(categoryLabelByName('Catégorie inconnue', new Map())).toBe('Catégorie inconnue');
	});

	it('fonctionne sans map fournie', () => {
		expect.assertions(1);

		expect(categoryLabelByName('Catégorie perso')).toBe('Catégorie perso');
	});
});

describe('buildDefaultKeyByName', () => {
	it('construit une map indexée par name', () => {
		expect.assertions(2);

		const map = buildDefaultKeyByName([
			{ name: 'Alimentation', defaultKey: 'food' },
			{ name: 'Autres', defaultKey: null }
		]);

		expect(map.get('Alimentation')).toBe('food');
		expect(map.get('Autres')).toBeNull();
	});
});
