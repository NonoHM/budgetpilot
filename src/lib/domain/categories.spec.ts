import { describe, expect, it } from 'vitest';
import { resolveProposalCategory, UNCLASSIFIED_CATEGORY } from './categories';

describe('resolveProposalCategory', () => {
	it('renvoie la catégorie suggérée quand une règle matche', () => {
		expect(resolveProposalCategory({ category: 'Courses' })).toBe('Courses');
	});

	it('retombe sur UNCLASSIFIED_CATEGORY quand aucune règle ne matche (pas de champ vide/cassé)', () => {
		expect(resolveProposalCategory(null)).toBe(UNCLASSIFIED_CATEGORY);
	});
});
