import { describe, expect, it } from 'vitest';
import type { Transaction } from '$lib/domain/transaction';
import {
	anonymizeLabel,
	anonymizeMerchant,
	buildMonthlyReport,
	buildPeriodReport,
	getRecurringPayments
} from './monthly';

const transactions: Transaction[] = [
	{
		id: 'income-manual',
		date: '2026-06-01',
		label: 'Salaire',
		amountCents: 200_000,
		type: 'income',
		category: 'Revenus',
		source: 'manual'
	},
	{
		id: 'income-legacy',
		date: '2026-06-02',
		label: 'Remboursement',
		amountCents: 15_000,
		type: 'income',
		category: 'Remboursements',
		source: 'csv'
	},
	{
		id: 'rent',
		date: '2026-06-03',
		label: 'VIREMENT LOYER REFAB123456789 FR7612341234123412341234123',
		amountCents: -80_000,
		type: 'expense',
		category: 'Logement',
		source: 'banque_populaire'
	},
	{
		id: 'subscription-1',
		date: '2026-06-04',
		label: 'ABONNEMENT MUSIQUE 123456',
		amountCents: -999,
		type: 'expense',
		category: 'Loisirs',
		source: 'banque_populaire'
	},
	{
		id: 'subscription-2',
		date: '2026-06-18',
		label: 'ABONNEMENT MUSIQUE 654321',
		amountCents: -1_049,
		type: 'expense',
		category: 'Loisirs',
		source: 'mock_connector'
	},
	{
		id: 'other-month',
		date: '2026-05-20',
		label: 'Ancien achat',
		amountCents: -5_000,
		type: 'expense',
		category: 'Autre',
		source: 'csv'
	}
];

describe('buildMonthlyReport', () => {
	it('compte toutes les incomes et expenses du mois sans filtre source', () => {
		expect.assertions(7);

		const report = buildMonthlyReport(transactions, '2026-06');

		expect(report.incomeCents).toBe(215_000);
		expect(report.expenseCents).toBe(82_048);
		expect(report.balanceCents).toBe(132_952);
		expect(report.transactionCount).toBe(5);
		expect(report.expenseAveragePerDayCents).toBe(2_735);
		expect(report.savingsRate).toBeCloseTo(0.618, 3);
		expect(report.takeaways.length).toBeGreaterThanOrEqual(3);
	});

	it('produit des takeaways structurés (code + champs optionnels), pas des chaînes libres', () => {
		expect.assertions(2);

		const report = buildMonthlyReport(transactions, '2026-06');
		const topCategoryTakeaway = report.takeaways.find(
			(takeaway) => takeaway.code === 'top_category'
		);

		expect(
			report.takeaways.every(
				(takeaway) => typeof takeaway === 'object' && typeof takeaway.code === 'string'
			)
		).toBe(true);
		expect(topCategoryTakeaway).toMatchObject({
			code: 'top_category',
			category: 'Logement',
			percent: expect.stringMatching(/^\d+ %$/)
		});
	});

	it('compare le mois courant au mois précédent', () => {
		expect.assertions(3);

		const report = buildMonthlyReport(transactions, '2026-06', {
			month: '2026-05',
			incomeCents: 100_000,
			expenseCents: 40_000,
			balanceCents: 60_000
		});

		expect(report.previousMonth?.incomeDeltaCents).toBe(115_000);
		expect(report.previousMonth?.expenseDeltaCents).toBe(42_048);
		expect(report.previousMonth?.balanceDeltaCents).toBe(72_952);
	});
});

describe('buildPeriodReport', () => {
	it('compte une income du mois précédent dans une période glissante', () => {
		expect.assertions(6);

		const report = buildPeriodReport(
			[
				{
					id: 'income-last-month',
					date: '2026-05-28',
					label: 'Salaire',
					amountCents: 177_000,
					type: 'income',
					category: 'Revenus',
					source: 'csv'
				},
				{
					id: 'expense-current-month',
					date: '2026-06-20',
					label: 'Courses',
					amountCents: -7_000,
					type: 'expense',
					category: 'Alimentation',
					source: 'banque_populaire'
				}
			],
			'30 derniers jours',
			undefined,
			{ dayCount: 30 }
		);

		expect(report.incomeCents).toBe(177_000);
		expect(report.expenseCents).toBe(7_000);
		expect(report.balanceCents).toBe(170_000);
		expect(report.expenseAveragePerDayCents).toBe(233);
		expect(report.savingsRate).toBeCloseTo(0.96, 2);
		expect(report.natureAnalysis.spendingCents).toBe(7_000);
	});

	it('sépare les natures analytiques', () => {
		expect.assertions(4);

		const report = buildPeriodReport(
			[
				{
					id: 'fee',
					date: '2026-06-10',
					label: 'Commission',
					amountCents: -500,
					type: 'expense',
					category: 'Frais bancaires',
					source: 'csv',
					nature: 'fee'
				},
				{
					id: 'refund',
					date: '2026-06-11',
					label: 'Remboursement',
					amountCents: 2_000,
					type: 'income',
					category: 'Remboursements',
					source: 'csv',
					nature: 'refund'
				},
				{
					id: 'investment',
					date: '2026-06-12',
					label: 'PEA',
					amountCents: -15_000,
					type: 'expense',
					category: 'Investissement',
					source: 'csv',
					nature: 'investment'
				}
			],
			'juin'
		);

		expect(report.natureAnalysis.feeCents).toBe(500);
		expect(report.natureAnalysis.refundCents).toBe(2_000);
		expect(report.natureAnalysis.investmentCents).toBe(15_000);
		expect(report.natureAnalysis.spendingCents).toBe(0);
	});
});

describe('getRecurringPayments', () => {
	it('détecte les libellés normalisés avec des montants similaires', () => {
		expect.assertions(9);

		const recurringPayments = getRecurringPayments(
			transactions.filter((transaction) => transaction.type === 'expense')
		);

		expect(recurringPayments).toHaveLength(1);
		expect(recurringPayments[0].label).toBe('Musique - Loisirs');
		expect(recurringPayments[0].label).not.toContain('ABONNEMENT');
		expect(recurringPayments[0].label).not.toContain('123456');
		expect(recurringPayments[0].amountCents).toBe(1_024);
		expect(recurringPayments[0].totalAmountCents).toBe(2_048);
		expect(recurringPayments[0].count).toBe(2);
		expect(recurringPayments[0].lastDate).toBe('2026-06-18');
		expect(recurringPayments[0].confidence).toBe('moyenne');
	});

	it('anonymise les plus grosses dépenses sans exposer de référence bancaire', () => {
		expect.assertions(8);

		const report = buildPeriodReport(
			[
				{
					id: 'card',
					date: '2026-06-10',
					label: 'CARTE 4970123412341234 AUCHAN 23/06;Debit;42,10;Reference BP123456789',
					amountCents: -4_210,
					type: 'expense',
					category: 'Alimentation',
					source: 'csv'
				},
				...transactions.filter((transaction) => transaction.date.startsWith('2026-06-'))
			],
			'juin'
		);
		const cardExpense = report.largestExpenses.find((expense) => expense.label.includes('Auchan'));

		expect(report.largestExpenses[0].label).toBe('Loyer - Logement');
		expect(cardExpense?.label).toBe('Auchan - Alimentation');
		expect(cardExpense?.label).not.toContain('4970123412341234');
		expect(cardExpense?.label).not.toContain('BP123456789');
		expect(cardExpense?.label).not.toContain('Reference');
		expect(cardExpense?.label).not.toContain('Debit');
		expect(report.largestExpenses[1].label).not.toContain('ABONNEMENT');
		expect(report.topCategories[0].percentageOfExpenses).toBeCloseTo(0.927, 3);
	});
});

describe('anonymizeMerchant / anonymizeLabel', () => {
	/**
	 * Recorded from the implementation BEFORE `anonymizeMerchant` was split out of
	 * `anonymizeLabel`. The split has to be a pure refactor — every existing caller (the reports,
	 * the cash-flow forecast view) keeps byte-identical output — so these literals are the
	 * regression guard, not a restatement of the current code.
	 */
	const RECORDED: [string, string, string][] = [
		['CB ABONNEMENT NETFLIX 0712', 'Abonnements', 'Netflix - Abonnements'],
		['PRELEVEMENT SEPA LOYER SCI DUPONT REF9912345', 'Logement', 'Loyer Sci Dupont - Logement'],
		['VIREMENT SALAIRE ACME SAS', 'Revenus', 'Salaire Acme Sas - Revenus'],
		// Nothing survives sanitization -> the neutral fallback, still composed with the category.
		['FR7630006000011234567890189', 'Divers', 'Dépense - Divers'],
		['123456789', 'Divers', 'Dépense - Divers'],
		['CB 12/03 CARTE', 'Divers', 'Dépense - Divers'],
		['Café Crème & Co', 'Restaurants', 'Cafe Creme Co - Restaurants']
	];

	it('anonymizeLabel produit exactement la même sortie qu’avant l’extraction', () => {
		for (const [label, category, expected] of RECORDED) {
			expect(anonymizeLabel(label, category)).toBe(expected);
		}
	});

	it('anonymizeLabel reste la composition de anonymizeMerchant et de la catégorie', () => {
		for (const [label, category] of RECORDED) {
			expect(anonymizeLabel(label, category)).toBe(`${anonymizeMerchant(label)} - ${category}`);
		}
	});

	it('anonymizeMerchant ne contient jamais la catégorie ni le séparateur', () => {
		for (const [label, category] of RECORDED) {
			const merchant = anonymizeMerchant(label);
			expect(merchant).not.toContain(' - ');
			expect(merchant).not.toContain(category);
		}
	});

	it('anonymizeMerchant retombe sur le libellé neutre quand rien ne survit', () => {
		expect(anonymizeMerchant('FR7630006000011234567890189')).toBe('Dépense');
	});
});
