import { describe, expect, it } from 'vitest';
import { getInitials, getEmailInitials } from './initials';

describe('getInitials', () => {
	it('prend la première lettre de chaque mot pour un libellé à deux mots', () => {
		expect(getInitials('Sophie Martin')).toBe('SM');
	});

	it("gère un seul mot en ne renvoyant qu'une lettre", () => {
		expect(getInitials('Restaurant')).toBe('R');
	});

	it('ignore les mots au-delà des deux premiers', () => {
		expect(getInitials('Jean Paul Dupont')).toBe('JP');
	});

	it('normalise les espaces multiples et le padding', () => {
		expect(getInitials('  Jean   Dupont  ')).toBe('JD');
	});

	it('renvoie une chaîne vide pour un libellé vide', () => {
		expect(getInitials('')).toBe('');
	});

	it("renvoie une chaîne vide pour un libellé composé uniquement d'espaces", () => {
		expect(getInitials('   ')).toBe('');
	});

	it('met les initiales en majuscules même si le libellé est en minuscules', () => {
		expect(getInitials('sophie martin')).toBe('SM');
	});
});

describe('getEmailInitials', () => {
	it('extrait les initiales depuis un local-part multi-mots séparé par un point', () => {
		expect(getEmailInitials('sophie.martin@gmail.com')).toBe('SM');
	});

	it('extrait les initiales depuis un local-part multi-mots séparé par un tiret ou underscore', () => {
		expect(getEmailInitials('jean-paul@example.com')).toBe('JP');
		expect(getEmailInitials('jean_paul@example.com')).toBe('JP');
	});

	it("replie sur les deux premières lettres pour un local-part composé d'un seul mot", () => {
		expect(getEmailInitials('paul@budgetpilot.com')).toBe('PA');
	});

	it("replie sur les deux premiers caractères quand le local-part n'est fait que de séparateurs", () => {
		expect(getEmailInitials('..@x.com')).toBe('..');
		expect(getEmailInitials('___@x.com')).toBe('__');
	});

	it('gère un local-part très court (une seule lettre)', () => {
		expect(getEmailInitials('a@x.com')).toBe('A');
	});

	it('gère une adresse sans arobase en traitant toute la chaîne comme local-part', () => {
		expect(getEmailInitials('sophie.martin')).toBe('SM');
	});

	it("gère une chaîne vide sans lever d'exception", () => {
		expect(getEmailInitials('')).toBe('');
	});

	it('gère un local-part avec des séparateurs en début/fin', () => {
		expect(getEmailInitials('.sophie.martin.@gmail.com')).toBe('SM');
	});
});
