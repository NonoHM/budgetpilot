import { describe, expect, it } from 'vitest';
import { summarizeMonthlyBudget } from './budget';
import type { Transaction } from './transaction';

const transactions: Transaction[] = [
	{
		id: 'income',
		date: '2026-06-01',
		label: 'Salaire',
		amountCents: 250_000,
		category: 'Revenus',
		source: 'manual'
	},
	{
		id: 'rent',
		date: '2026-06-02',
		label: 'Loyer',
		amountCents: -80_000,
		category: 'Logement',
		source: 'manual'
	},
	{
		id: 'food',
		date: '2026-06-03',
		label: 'Courses',
		amountCents: -12_345,
		category: 'Alimentation',
		source: 'csv'
	},
	{
		id: 'old',
		date: '2026-05-28',
		label: 'Ancien achat',
		amountCents: -99_999,
		category: 'Loisirs',
		source: 'manual'
	}
];

describe('summarizeMonthlyBudget', () => {
	it('retourne un dashboard mensuel vide sans fixture', () => {
		expect.assertions(4);

		const summary = summarizeMonthlyBudget([], [], '2026-06');

		expect(summary.incomeCents).toBe(0);
		expect(summary.expenseCents).toBe(0);
		expect(summary.balanceCents).toBe(0);
		expect(summary.categorySummaries).toEqual([]);
	});

	it('calcule revenus, dépenses et solde mensuel en centimes', () => {
		expect.assertions(3);

		const summary = summarizeMonthlyBudget(transactions, [], '2026-06');

		expect(summary.incomeCents).toBe(250_000);
		expect(summary.expenseCents).toBe(92_345);
		expect(summary.balanceCents).toBe(157_655);
	});

	it('compte toutes les transactions income et expense du mois', () => {
		expect.assertions(3);

		const summary = summarizeMonthlyBudget(
			[
				...transactions,
				{
					id: 'internal',
					date: '2026-06-04',
					label: 'Virement interne',
					amountCents: 100_000,
					type: 'income',
					category: 'Virement interne',
					source: 'banque_populaire'
				}
			],
			[],
			'2026-06'
		);

		expect(summary.incomeCents).toBe(350_000);
		expect(summary.expenseCents).toBe(92_345);
		expect(summary.balanceCents).toBe(257_655);
	});

	it('détecte un dépassement de budget par catégorie', () => {
		expect.assertions(2);

		const summary = summarizeMonthlyBudget(
			transactions,
			[
				{ category: 'Logement', limitCents: 75_000 },
				{ category: 'Alimentation', limitCents: 20_000 }
			],
			'2026-06'
		);

		expect(summary.categorySummaries[0]).toMatchObject({
			category: 'Logement',
			spentCents: 80_000,
			remainingCents: -5_000,
			usagePercentage: 107,
			status: 'over_budget',
			isOverBudget: true
		});
		expect(summary.categorySummaries[1]).toMatchObject({
			category: 'Alimentation',
			spentCents: 12_345,
			remainingCents: 7_655,
			usagePercentage: 62,
			status: 'ok',
			isOverBudget: false
		});
	});

	it('marque les budgets proches de la limite a partir de 80 %', () => {
		expect.assertions(1);

		const summary = summarizeMonthlyBudget(
			transactions,
			[{ category: 'Alimentation', limitCents: 15_000 }],
			'2026-06'
		);

		expect(summary.categorySummaries[0]).toMatchObject({
			category: 'Alimentation',
			usagePercentage: 82,
			status: 'near_limit'
		});
	});

	it('n inclut pas un transfert dans le budget sans enveloppe explicite', () => {
		expect.assertions(2);

		const summary = summarizeMonthlyBudget(
			[
				...transactions,
				{
					id: 'transfer',
					date: '2026-06-05',
					label: 'Virement interne',
					amountCents: -30_000,
					type: 'expense',
					category: 'Transfert',
					source: 'csv',
					nature: 'transfer'
				}
			],
			[{ category: 'Logement', limitCents: 100_000 }],
			'2026-06'
		);

		expect(summary.categorySummaries[0].spentCents).toBe(80_000);
		expect(summary.expenseCents).toBe(122_345);
	});
});
