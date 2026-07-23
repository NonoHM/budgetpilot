import { describe, expect, it } from 'vitest';
import { widthClass } from './widthClass';

describe('widthClass', () => {
	it('renvoie la classe correspondante pour une valeur nominale entière', () => {
		expect(widthClass(42)).toBe('w-[42%]');
	});

	it('renvoie w-[0%] pour 0', () => {
		expect(widthClass(0)).toBe('w-[0%]');
	});

	it('renvoie w-[100%] pour 100', () => {
		expect(widthClass(100)).toBe('w-[100%]');
	});

	it('clampe une valeur négative à 0', () => {
		expect(widthClass(-5)).toBe('w-[0%]');
	});

	it('clampe une valeur supérieure à 100', () => {
		expect(widthClass(137)).toBe('w-[100%]');
	});

	it('arrondit une valeur décimale au plus proche entier (42.6 -> 43%)', () => {
		expect(widthClass(42.6)).toBe('w-[43%]');
	});

	it('arrondit une valeur décimale au plus proche entier (42.4 -> 42%)', () => {
		expect(widthClass(42.4)).toBe('w-[42%]');
	});

	it('arrondit .5 vers le haut (banker rounding non applicable ici)', () => {
		expect(widthClass(42.5)).toBe('w-[43%]');
	});

	it('gère une valeur décimale négative en la clampant à 0 après arrondi', () => {
		expect(widthClass(-0.4)).toBe('w-[0%]');
	});

	it('gère un dépassement fractionnaire au-delà de 100 en clampant à 100%', () => {
		expect(widthClass(100.9)).toBe('w-[100%]');
	});

	it('retombe sur w-[0%] pour NaN (ex. division par zéro chez un appelant)', () => {
		expect(widthClass(NaN)).toBe('w-[0%]');
	});

	it('retombe sur w-[0%] pour Infinity/-Infinity', () => {
		expect(widthClass(Infinity)).toBe('w-[0%]');
		expect(widthClass(-Infinity)).toBe('w-[0%]');
	});
});
