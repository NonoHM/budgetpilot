import { describe, expect, it } from 'vitest';
import { allocationsOf, type CategoryAllocation } from '$lib/domain/allocation';
import type { Transaction, TransactionNature } from '$lib/domain/transaction';
import {
	analyzeTransactionNatures,
	buildCategoryNatureMap,
	getEffectiveCategory,
	getEffectiveTransactionNature,
	isUncategorizedByCategory,
	normalizeCategoryName,
	parseTransactionNatureInput,
	shouldCountTransactionInBudget
} from './nature';

/**
 * The one CategoryAllocation an unsplit transaction fixture yields. Every fixture below already
 * pins its own `nature` explicitly, so this only calls allocationsOf (the real remainder rule) —
 * it never re-derives a default.
 */
function toAllocation(tx: Transaction & { nature: TransactionNature }): CategoryAllocation {
	return allocationsOf(tx)[0];
}

describe('transaction nature helpers', () => {
	it('applique la priorité manuel puis mapping puis défaut', () => {
		expect.assertions(3);

		const mappings = buildCategoryNatureMap([{ categoryName: 'Alimentation', nature: 'spending' }]);

		expect(
			getEffectiveTransactionNature(
				{
					amountCents: -1_000,
					type: 'expense',
					category: 'Alimentation',
					natureManual: 'fee'
				},
				mappings
			)
		).toEqual({ nature: 'fee', source: 'manual' });
		expect(
			getEffectiveTransactionNature(
				{
					amountCents: -1_000,
					type: 'expense',
					category: 'Alimentation',
					natureManual: null
				},
				mappings
			)
		).toEqual({ nature: 'spending', source: 'category' });
		expect(
			getEffectiveTransactionNature(
				{
					amountCents: 1_000,
					type: 'income',
					category: 'Salaire',
					natureManual: null
				},
				mappings
			)
		).toEqual({ nature: 'income', source: 'default' });
	});

	it('valide et normalise les entrées', () => {
		expect.assertions(3);

		expect(normalizeCategoryName('  Alimentation  ')).toBe('Alimentation');
		expect(normalizeCategoryName('Bad<')).toBe('');
		expect(parseTransactionNatureInput('transfer')).toBe('transfer');
	});

	it('accepte "income" comme nature valide, avec ou sans espaces superflus', () => {
		expect.assertions(2);

		expect(parseTransactionNatureInput('income')).toBe('income');
		expect(parseTransactionNatureInput('  income  ')).toBe('income');
	});

	it('applique le fallback par défaut expense→spending sans mapping ni nature manuelle', () => {
		expect.assertions(1);

		expect(
			getEffectiveTransactionNature(
				{
					amountCents: -500,
					type: 'expense',
					category: 'Catégorie inconnue',
					natureManual: null
				},
				new Map()
			)
		).toEqual({ nature: 'spending', source: 'default' });
	});

	it('applique le fallback par défaut income→income sans mapping ni nature manuelle', () => {
		expect.assertions(1);

		expect(
			getEffectiveTransactionNature(
				{
					amountCents: 3_000,
					type: 'income',
					category: 'Catégorie inconnue',
					natureManual: null
				},
				new Map()
			)
		).toEqual({ nature: 'income', source: 'default' });
	});

	it('sépare correctement les montants analytiques', () => {
		expect.assertions(4);

		const analyticalTransactions: Array<Transaction & { nature: TransactionNature }> = [
			{
				id: '1',
				date: '2026-06-01',
				label: 'Uber',
				amountCents: -1_500,
				type: 'expense',
				category: 'Transport',
				source: 'csv',
				nature: 'spending'
			},
			{
				id: '2',
				date: '2026-06-01',
				label: 'PEA',
				amountCents: -10_000,
				type: 'expense',
				category: 'Investissement',
				source: 'csv',
				nature: 'investment'
			},
			{
				id: '3',
				date: '2026-06-01',
				label: 'Remboursement',
				amountCents: 2_000,
				type: 'income',
				category: 'Remboursements',
				source: 'csv',
				nature: 'refund'
			},
			{
				id: '4',
				date: '2026-06-01',
				label: 'Salaire',
				amountCents: 250_000,
				type: 'income',
				category: 'Revenus',
				source: 'csv',
				nature: 'income'
			}
		];

		const summary = analyzeTransactionNatures(analyticalTransactions.map(toAllocation));

		expect(summary.spendingCents).toBe(1_500);
		expect(summary.investmentCents).toBe(10_000);
		expect(summary.refundCents).toBe(2_000);
		expect(summary.incomeCents).toBe(250_000);
	});

	it("n'incrémente incomeCents que pour les transactions nature=income, sans toucher aux autres compteurs", () => {
		expect.assertions(7);

		const incomeOnlyTransactions: Array<Transaction & { nature: TransactionNature }> = [
			{
				id: '1',
				date: '2026-06-01',
				label: 'Salaire',
				amountCents: 200_000,
				type: 'income',
				category: 'Revenus',
				source: 'csv',
				nature: 'income'
			},
			{
				id: '2',
				date: '2026-06-01',
				label: 'Prime',
				amountCents: 50_000,
				type: 'income',
				category: 'Revenus',
				source: 'csv',
				nature: 'income'
			}
		];

		const summary = analyzeTransactionNatures(incomeOnlyTransactions.map(toAllocation));

		expect(summary.incomeCents).toBe(250_000);
		expect(summary.spendingCents).toBe(0);
		expect(summary.investmentCents).toBe(0);
		expect(summary.transferCents).toBe(0);
		expect(summary.refundCents).toBe(0);
		expect(summary.feeCents).toBe(0);
		expect(summary.uncategorizedCents).toBe(0);
	});
});

describe('shouldCountTransactionInBudget', () => {
	it("exclut toujours les transactions de kind income, même si leur nature est 'income'", () => {
		expect.assertions(1);

		expect(
			shouldCountTransactionInBudget(
				{
					type: 'income',
					amountCents: 250_000,
					category: 'Revenus',
					nature: 'income'
				},
				new Set(['Revenus'])
			)
		).toBe(false);
	});

	it('compte une dépense de nature spending appartenant à une catégorie budgétée', () => {
		expect.assertions(1);

		expect(
			shouldCountTransactionInBudget(
				{
					type: 'expense',
					amountCents: -1_000,
					category: 'Alimentation',
					nature: 'spending'
				},
				new Set(['Alimentation'])
			)
		).toBe(true);
	});
});

describe('getEffectiveCategory', () => {
	it('priorise manualCategory sur le nom de la catégorie liée', () => {
		expect.assertions(1);

		expect(
			getEffectiveCategory({ manualCategory: 'Loisirs', category: { name: 'Alimentation' } })
		).toBe('Loisirs');
	});

	it('retombe sur le nom de la catégorie liée sans manualCategory', () => {
		expect.assertions(1);

		expect(getEffectiveCategory({ manualCategory: null, category: { name: 'Alimentation' } })).toBe(
			'Alimentation'
		);
	});

	it('retombe sur "Non catégorisé" sans manualCategory ni catégorie liée', () => {
		expect.assertions(1);

		expect(getEffectiveCategory({ manualCategory: null, category: null })).toBe('uncategorized');
	});
});

describe('isUncategorizedByCategory', () => {
	it('est vrai quand la catégorie effective est "Non catégorisé"', () => {
		expect.assertions(1);

		expect(
			isUncategorizedByCategory({ manualCategory: null, category: { name: 'uncategorized' } })
		).toBe(true);
	});

	it("est faux dès qu'une catégorie déliberée est assignée, quelle que soit la nature", () => {
		expect.assertions(1);

		expect(
			isUncategorizedByCategory({
				manualCategory: 'Alimentation',
				category: { name: 'uncategorized' }
			})
		).toBe(false);
	});
});
