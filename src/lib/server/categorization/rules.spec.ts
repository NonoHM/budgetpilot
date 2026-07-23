import { describe, expect, it } from 'vitest';
import {
	applyCategorizationRules,
	findMatchingCategoryRule,
	isSafeRegexPattern,
	parseCategoryRuleInput
} from './rules';

describe('applyCategorizationRules', () => {
	it('catégorise un libellé par matching contains insensible à la casse', () => {
		expect.assertions(2);

		const result = applyCategorizationRules(
			{
				label: 'Paiement AUCHAN',
				category: 'Autre',
				type: 'expense'
			},
			[
				{
					pattern: 'auchan',
					targetCategory: 'Alimentation',
					type: 'expense',
					active: true
				}
			]
		);

		expect(result.category).toBe('Alimentation');
		expect(result.type).toBe('expense');
	});

	it('applique une règle utilisateur sans modifier le type ni le statut budget', () => {
		expect.assertions(2);

		const result = applyCategorizationRules(
			{
				label: 'REVOLUT recharge',
				category: 'Autre',
				type: 'expense'
			},
			[
				{
					pattern: 'REVOLUT',
					targetCategory: 'Virement interne',
					type: 'expense',
					active: true
				}
			]
		);

		expect(result.category).toBe('Virement interne');
		expect(result.type).toBe('expense');
	});

	it('propage une nature cible quand la règle en définit une', () => {
		expect.assertions(1);

		const result = applyCategorizationRules(
			{
				label: 'Recharge via Carte',
				category: 'Autre',
				type: 'expense'
			},
			[
				{
					pattern: 'Recharge via',
					targetCategory: 'Transfert',
					targetNature: 'transfer',
					type: 'expense',
					active: true
				}
			]
		);

		expect(result.targetNature).toBe('transfer');
	});
});

describe('CategoryRule utilisateur', () => {
	it('normalise et valide les champs de règle', () => {
		expect.assertions(1);

		const result = parseCategoryRuleInput({
			name: '  Patreon  mensuel ',
			matchText: ' Patreon ',
			targetCategory: ' Abonnements '
		});

		expect(result).toEqual({
			ok: true,
			value: {
				name: 'Patreon mensuel',
				matchText: 'Patreon',
				targetCategory: 'Abonnements',
				targetNature: null,
				enabled: true,
				isRegex: false
			}
		});
	});

	it('refuse les chevrons, caractères de contrôle et champs trop longs', () => {
		expect.assertions(4);

		expect(
			parseCategoryRuleInput({ name: '<x>', matchText: 'Patreon', targetCategory: 'Abonnements' })
				.ok
		).toBe(false);
		expect(
			parseCategoryRuleInput({
				name: 'x',
				matchText: 'Patreon\u0000',
				targetCategory: 'Abonnements'
			}).ok
		).toBe(false);
		expect(
			parseCategoryRuleInput({
				name: 'x',
				matchText: 'a'.repeat(81),
				targetCategory: 'Abonnements'
			}).ok
		).toBe(false);
		expect(
			parseCategoryRuleInput({
				name: 'x',
				matchText: 'Patreon',
				targetCategory: 'Abonnements',
				targetNature: 'weird'
			}).ok
		).toBe(false);
	});

	it('accepte isRegex avec un pattern valide', () => {
		expect.assertions(1);

		const result = parseCategoryRuleInput({
			name: 'Cartes',
			matchText: '^CB\\d+$',
			targetCategory: 'Abonnements',
			isRegex: true
		});

		expect(result).toEqual({
			ok: true,
			value: {
				name: 'Cartes',
				matchText: '^CB\\d+$',
				targetCategory: 'Abonnements',
				targetNature: null,
				enabled: true,
				isRegex: true
			}
		});
	});

	it('refuse isRegex avec un pattern non compilable', () => {
		expect.assertions(1);

		const result = parseCategoryRuleInput({
			name: 'Cassée',
			matchText: '(',
			targetCategory: 'Abonnements',
			isRegex: true
		});

		expect(result.ok).toBe(false);
	});

	it("accepte isRegex avec des quantificateurs imbriqués : RE2 est linéaire, plus de pattern 'dangereux'", () => {
		expect.assertions(1);

		const result = parseCategoryRuleInput({
			name: 'OK',
			matchText: '(a+)+',
			targetCategory: 'Abonnements',
			isRegex: true
		});

		expect(result.ok).toBe(true);
	});

	it('matche sans tenir compte de la casse', () => {
		expect.assertions(1);

		const rule = findMatchingCategoryRule(
			{ label: 'Paiement PATREON Europe', manualCategory: null },
			[
				{
					id: 'rule-1',
					name: 'Patreon',
					matchText: 'patreon',
					targetCategory: 'Abonnements',
					enabled: true
				}
			]
		);

		expect(rule?.targetCategory).toBe('Abonnements');
	});

	it('ignore une transaction déjà catégorisée manuellement', () => {
		expect.assertions(1);

		const rule = findMatchingCategoryRule(
			{ label: 'Paiement PATREON Europe', manualCategory: 'Loisirs' },
			[
				{
					id: 'rule-1',
					name: 'Patreon',
					matchText: 'patreon',
					targetCategory: 'Abonnements',
					enabled: true
				}
			]
		);

		expect(rule).toBeNull();
	});

	it('matche via un pattern regex, insensible à la casse', () => {
		expect.assertions(2);

		const rules = [
			{
				id: 'rule-1',
				name: 'Cartes',
				matchText: '^cb\\d{4}$',
				targetCategory: 'Cartes',
				enabled: true,
				isRegex: true
			}
		];

		expect(
			findMatchingCategoryRule({ label: 'CB1234', manualCategory: null }, rules)?.targetCategory
		).toBe('Cartes');
		expect(findMatchingCategoryRule({ label: 'CB12345', manualCategory: null }, rules)).toBeNull();
	});

	it('ignore silencieusement une règle regex invalide au matching (défense en profondeur)', () => {
		expect.assertions(1);

		const rules = [
			{
				id: 'rule-1',
				name: 'Cassée',
				matchText: '(',
				targetCategory: 'X',
				enabled: true,
				isRegex: true
			}
		];

		expect(
			findMatchingCategoryRule({ label: 'peu importe', manualCategory: null }, rules)
		).toBeNull();
	});
});

describe('isSafeRegexPattern', () => {
	it('accepte un pattern regex simple et valide', () => {
		expect.assertions(1);

		expect(isSafeRegexPattern('^CB\\d+$')).toBe(true);
	});

	it('rejette un pattern non compilable', () => {
		expect.assertions(1);

		expect(isSafeRegexPattern('(')).toBe(false);
	});

	it('accepte les quantificateurs imbriqués : RE2 est linéaire par construction, plus de catastrophic backtracking possible', () => {
		expect.assertions(2);

		expect(isSafeRegexPattern('(a+)+')).toBe(true);
		expect(isSafeRegexPattern('(a*)+$')).toBe(true);
	});

	it('rejette les patterns trop longs', () => {
		expect.assertions(1);

		expect(isSafeRegexPattern('a'.repeat(81))).toBe(false);
	});
});
