import { describe, expect, it } from 'vitest';
import { normalizeHostEntry, parseHostsCsv } from './hosts';

describe('normalizeHostEntry', () => {
	it('laisse un hôte simple inchangé', () => {
		expect(normalizeHostEntry('example.com')).toBe('example.com');
	});

	it('encadre une adresse IPv6 nue de crochets', () => {
		expect(normalizeHostEntry('::1')).toBe('[::1]');
	});

	it('ne touche pas une adresse IPv6 déjà encadrée', () => {
		expect(normalizeHostEntry('[::1]')).toBe('[::1]');
	});

	it('retourne une chaîne vide telle quelle', () => {
		expect(normalizeHostEntry('')).toBe('');
	});
});

describe('parseHostsCsv', () => {
	it('retourne un tableau vide pour undefined', () => {
		expect(parseHostsCsv(undefined)).toEqual([]);
	});

	it('retourne un tableau vide pour une chaîne vide', () => {
		expect(parseHostsCsv('')).toEqual([]);
	});

	it('retourne un tableau vide pour une chaîne composée uniquement d’espaces', () => {
		expect(parseHostsCsv('   ')).toEqual([]);
	});

	it('parse une liste simple séparée par des virgules', () => {
		expect(parseHostsCsv('a.example,b.example')).toEqual(['a.example', 'b.example']);
	});

	it('trim les espaces autour de chaque hôte', () => {
		expect(parseHostsCsv(' a.example ,  b.example  ')).toEqual(['a.example', 'b.example']);
	});

	it('normalise une adresse IPv6 nue au sein de la liste', () => {
		expect(parseHostsCsv('a.example, ::1')).toEqual(['a.example', '[::1]']);
	});

	it('laisse une adresse IPv6 déjà encadrée inchangée au sein de la liste', () => {
		expect(parseHostsCsv('[::1], a.example')).toEqual(['[::1]', 'a.example']);
	});

	it('filtre les entrées vides issues de virgules successives', () => {
		expect(parseHostsCsv('a.example,,b.example, ,')).toEqual(['a.example', 'b.example']);
	});
});
