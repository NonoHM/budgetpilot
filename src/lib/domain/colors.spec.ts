import { describe, expect, it } from 'vitest';
import {
	CATEGORY_PALETTE,
	CATEGORY_PALETTE_OTHERS,
	NATURE_COLORS,
	NET_WORTH_TYPE_COLORS,
	hexToBgClass,
	resolveCategoryColor,
	resolveCategoryColorClass
} from './colors';

describe('hexToBgClass', () => {
	it('mappe chaque couleur de CATEGORY_PALETTE vers une classe bg-[hex] cohérente', () => {
		for (const hex of CATEGORY_PALETTE) {
			expect(hexToBgClass(hex)).toBe(`bg-[${hex}]`);
		}
	});

	it('mappe CATEGORY_PALETTE_OTHERS vers sa classe bg-[hex]', () => {
		expect(hexToBgClass(CATEGORY_PALETTE_OTHERS)).toBe(`bg-[${CATEGORY_PALETTE_OTHERS}]`);
	});

	it('mappe chaque couleur de NATURE_COLORS vers une classe bg-[hex] cohérente', () => {
		for (const hex of Object.values(NATURE_COLORS)) {
			expect(hexToBgClass(hex)).toBe(`bg-[${hex}]`);
		}
	});

	it('mappe chaque couleur de NET_WORTH_TYPE_COLORS vers une classe bg-[hex] cohérente', () => {
		for (const hex of Object.values(NET_WORTH_TYPE_COLORS)) {
			expect(hexToBgClass(hex)).toBe(`bg-[${hex}]`);
		}
	});

	it('ne renvoie jamais undefined pour une couleur connue', () => {
		const allKnownColors = [
			...CATEGORY_PALETTE,
			CATEGORY_PALETTE_OTHERS,
			...Object.values(NATURE_COLORS),
			...Object.values(NET_WORTH_TYPE_COLORS)
		];
		for (const hex of allKnownColors) {
			expect(hexToBgClass(hex)).toBeDefined();
			expect(hexToBgClass(hex)).not.toBe('');
		}
	});

	it('replie sur la classe neutre CATEGORY_PALETTE_OTHERS pour une couleur hex inconnue', () => {
		expect(hexToBgClass('#123456')).toBe(hexToBgClass(CATEGORY_PALETTE_OTHERS));
	});

	it('replie sur la classe neutre pour une chaîne vide', () => {
		expect(hexToBgClass('')).toBe(hexToBgClass(CATEGORY_PALETTE_OTHERS));
	});
});

describe('resolveCategoryColorClass', () => {
	const uncategorizedName = 'Non catégorisé';

	it('renvoie la classe correspondant à resolveCategoryColor pour une catégorie normale', () => {
		const categoryName = 'Alimentation';
		const expectedHex = resolveCategoryColor(categoryName, uncategorizedName);
		expect(resolveCategoryColorClass(categoryName, uncategorizedName)).toBe(
			hexToBgClass(expectedHex)
		);
	});

	it('renvoie la classe neutre pour la catégorie "Non catégorisé"', () => {
		expect(resolveCategoryColorClass(uncategorizedName, uncategorizedName)).toBe(
			hexToBgClass(CATEGORY_PALETTE_OTHERS)
		);
	});

	it('renvoie la classe neutre pour un nom de catégorie vide', () => {
		expect(resolveCategoryColorClass('', uncategorizedName)).toBe(
			hexToBgClass(CATEGORY_PALETTE_OTHERS)
		);
	});

	it("est stable/déterministe pour un même nom de catégorie (indépendant de l'ordre)", () => {
		const categoryName = 'Transport';
		const first = resolveCategoryColorClass(categoryName, uncategorizedName);
		const second = resolveCategoryColorClass(categoryName, uncategorizedName);
		expect(first).toBe(second);
	});

	it('ne renvoie jamais undefined quelle que soit la catégorie', () => {
		for (const name of ['Loisirs', 'Santé', 'Salaire', 'Épargne', 'x']) {
			expect(resolveCategoryColorClass(name, uncategorizedName)).toBeDefined();
		}
	});
});
