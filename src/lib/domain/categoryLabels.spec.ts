import { describe, expect, it } from 'vitest';
import * as m from '$lib/paraglide/messages';
import { UNCLASSIFIED_CATEGORY } from './categories';
import { categoryDisplayName } from './categoryLabels';

describe('categoryDisplayName', () => {
	it('traduit le sentinel « à classer » au lieu d’afficher le slug technique', () => {
		expect.assertions(2);

		const label = categoryDisplayName(UNCLASSIFIED_CATEGORY);

		expect(label).toBe(m.common_category_uncategorized());
		expect(label).not.toBe(UNCLASSIFIED_CATEGORY);
	});

	it('rend une catégorie par défaut sous son nom stocké, sans traduction (#162)', () => {
		expect.assertions(2);

		// LE TEST QUI DIT CE QUI A CHANGÉ. « Alimentation » est l’une des quatorze catégories
		// semées : elle s’affichait « Groceries » sur une instance anglaise, parce que son
		// `defaultKey` décidait de son libellé. Elle s’affiche désormais telle qu’elle est
		// stockée, dans toutes les langues.
		expect(categoryDisplayName('Alimentation')).toBe('Alimentation');
		expect(categoryDisplayName('Alimentation')).not.toBe(
			m.category_default_food({}, { locale: 'en' })
		);
	});

	it('rend un nom saisi par l’utilisateur tel quel', () => {
		expect.assertions(1);

		expect(categoryDisplayName('Mes courses')).toBe('Mes courses');
	});

	it('ne traite spécialement que le sentinel, y compris pour un nom qui lui ressemble', () => {
		expect.assertions(2);

		// La casse compte ici, délibérément : `categoryDisplayName` compare au slug EXACT, sans
		// passer par `computeNameKey`. Une catégorie que l’utilisateur aurait nommée
		// « Uncategorized » est une catégorie ordinaire et doit s’afficher telle quelle ; c’est
		// `isReservedCategoryName` qui refuse de la CRÉER, et c’est le bon endroit pour ce refus.
		expect(categoryDisplayName('Uncategorized')).toBe('Uncategorized');
		expect(categoryDisplayName('UNCATEGORIZED')).toBe('UNCATEGORIZED');
	});
});
