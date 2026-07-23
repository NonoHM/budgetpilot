import { describe, expect, it } from 'vitest';
import { anonymizeDetailText, anonymizeReference, truncateText } from './anonymize';

describe('truncateText', () => {
	it('laisse intact un texte sous la limite', () => {
		expect.assertions(1);
		expect(truncateText('Loyer', 10)).toBe('Loyer');
	});

	it('tronque et ajoute une ellipse au-delà de la limite', () => {
		expect.assertions(1);
		expect(truncateText('Un très long libellé de transaction', 10)).toBe('Un très l…');
	});

	it('collapse les espaces multiples avant de mesurer la longueur', () => {
		expect.assertions(1);
		expect(truncateText('  a    b  ', 10)).toBe('a b');
	});

	it('gère la chaîne vide', () => {
		expect.assertions(1);
		expect(truncateText('', 10)).toBe('');
	});
});

describe('anonymizeDetailText', () => {
	it('masque un motif de carte bancaire avec préfixe numérique', () => {
		expect.assertions(1);
		expect(anonymizeDetailText('1234 CB****5678 ACHAT')).toBe('CB****ACHAT');
	});

	it('masque un motif de carte bancaire sans préfixe numérique', () => {
		expect.assertions(1);
		expect(anonymizeDetailText('PAIEMENT CB**1234 BOULANGERIE')).toBe('PAIEMENT CB****BOULANGERIE');
	});

	it('masque une suite d’étoiles suivie de chiffres', () => {
		expect.assertions(1);
		expect(anonymizeDetailText('CARTE ****12 PARIS')).toBe('CARTE ****PARIS');
	});

	it('masque une référence alphanumérique longue', () => {
		expect.assertions(1);
		expect(anonymizeDetailText('VIR REF1234567890 SALAIRE')).toBe('VIR REF… SALAIRE');
	});

	it('masque une longue suite de chiffres (numéro de compte/référence)', () => {
		expect.assertions(1);
		expect(anonymizeDetailText('VIREMENT 12345678901 RECU')).toBe('VIREMENT 123… RECU');
	});

	it('ne modifie pas un texte sans motif sensible', () => {
		expect.assertions(1);
		expect(anonymizeDetailText('Courses supermarché')).toBe('Courses supermarché');
	});

	it('gère la chaîne vide', () => {
		expect.assertions(1);
		expect(anonymizeDetailText('')).toBe('');
	});

	it('gère un format déjà masqué sans erreur (idempotent sur le motif étoile)', () => {
		expect.assertions(1);
		expect(anonymizeDetailText('CB**** ACHAT')).toBe('CB**** ACHAT');
	});

	it('tronque le résultat au-delà de 96 caractères après masquage', () => {
		expect.assertions(1);
		const longLabel = `ACHAT ${'x'.repeat(120)}`;
		const result = anonymizeDetailText(longLabel);
		expect(result.length).toBeLessThanOrEqual(96);
	});

	it('accepte une longueur de troncature personnalisée', () => {
		expect.assertions(1);
		expect(anonymizeDetailText('Courses supermarché du quartier', 18)).toBe('Courses supermarc…');
	});
});

describe('anonymizeReference', () => {
	it('masque chaque segment séparé par un pipe indépendamment', () => {
		expect.assertions(1);
		expect(anonymizeReference('12345678901|REF1234567890')).toBe('123…|REF…');
	});

	it('gère un segment unique sans pipe', () => {
		expect.assertions(1);
		expect(anonymizeReference('12345678901')).toBe('123…');
	});

	it('gère la chaîne vide', () => {
		expect.assertions(1);
		expect(anonymizeReference('')).toBe('');
	});
});
