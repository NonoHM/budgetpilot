import { describe, expect, it } from 'vitest';
import {
	filterTransactionsByQuery,
	isValidRegexQuery,
	matchesQuery,
	parseQueryMode
} from './search';

describe('parseQueryMode', () => {
	it('accepte "regex"', () => {
		expect.assertions(1);

		expect(parseQueryMode('regex')).toBe('regex');
	});

	it('retombe sur "contains" pour toute autre valeur', () => {
		expect.assertions(3);

		expect(parseQueryMode('contains')).toBe('contains');
		expect(parseQueryMode('bogus')).toBe('contains');
		expect(parseQueryMode(null)).toBe('contains');
	});
});

describe('matchesQuery', () => {
	it('mode contains : insensible à la casse et aux accents', () => {
		expect.assertions(2);

		expect(matchesQuery('Dépenses courantes', 'depenses', 'contains')).toBe(true);
		expect(matchesQuery('Dépenses courantes', 'DEPENSES', 'contains')).toBe(true);
	});

	it('mode regex : insensible à la casse', () => {
		expect.assertions(2);

		expect(matchesQuery('CB1234 AUCHAN', '^cb\\d{4}', 'regex')).toBe(true);
		expect(matchesQuery('AUCHAN COURSES', '^cb\\d{4}', 'regex')).toBe(false);
	});

	it('mode regex : un pattern invalide ne matche jamais (pas de throw)', () => {
		expect.assertions(1);

		expect(matchesQuery('peu importe', '(', 'regex')).toBe(false);
	});

	it('mode regex : borne la longueur du libellé testé (défense en profondeur anti-ReDoS)', () => {
		expect.assertions(1);

		const hugeLabel = `${'a'.repeat(400)}MATCH`;

		expect(matchesQuery(hugeLabel, 'MATCH$', 'regex')).toBe(false);
	});
});

describe('isValidRegexQuery', () => {
	it('valide un pattern compilable', () => {
		expect.assertions(1);

		expect(isValidRegexQuery('^cb\\d+$')).toBe(true);
	});

	it('rejette un pattern non compilable', () => {
		expect.assertions(1);

		expect(isValidRegexQuery('(')).toBe(false);
	});

	it('accepte les quantificateurs imbriqués : RE2 (moteur linéaire) exclut le catastrophic backtracking', () => {
		expect.assertions(1);

		expect(isValidRegexQuery('(a+)+')).toBe(true);
	});
});

describe('filterTransactionsByQuery', () => {
	const transactions = [{ label: 'Dépenses courantes' }, { label: 'AUCHAN COURSES' }];

	it('retourne la liste inchangée si la query est vide', () => {
		expect.assertions(1);

		expect(filterTransactionsByQuery(transactions, '', 'contains')).toHaveLength(2);
	});

	it('filtre en mode contains, accent-insensible', () => {
		expect.assertions(1);

		expect(filterTransactionsByQuery(transactions, 'depenses', 'contains')).toHaveLength(1);
	});

	it('filtre en mode regex', () => {
		expect.assertions(1);

		expect(filterTransactionsByQuery(transactions, '^auchan', 'regex')).toHaveLength(1);
	});
});
