import { describe, expect, it } from 'vitest';
import { summarizeBudgetTransactions } from '$lib/domain/budget';
import type { Transaction } from '$lib/domain/transaction';
import { buildTransactionSummary } from './summary';

const transactions: Transaction[] = [
	{
		id: 'income',
		date: '2026-06-01',
		label: 'Salaire',
		amountCents: 300_000,
		type: 'income',
		category: 'Revenus',
		source: 'manual'
	},
	{
		id: 'expense-1',
		date: '2026-06-05',
		label: 'Loyer juin',
		amountCents: -120_000,
		type: 'expense',
		category: 'Logement',
		source: 'manual'
	},
	{
		id: 'expense-2',
		date: '2026-06-10',
		label: 'Assurance habitation',
		amountCents: -5_000,
		type: 'expense',
		category: 'Logement',
		source: 'manual'
	},
	{
		id: 'expense-3',
		date: '2026-06-15',
		label: 'Courses Auchan',
		amountCents: -15_000,
		type: 'expense',
		category: 'Alimentation',
		source: 'manual'
	}
];

/** Every property name in a nested structure, so a key check cannot miss a nested one. */
function collectKeys(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(collectKeys);
	if (value && typeof value === 'object') {
		return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
	}
	return [];
}

describe('buildTransactionSummary and tag data', () => {
	it('carries no tag data into the AI payload, on either of its two paths', () => {
		expect.assertions(3);

		// This is the actual chokepoint: buildTransactionSummary's return value IS the prompt
		// payload (see insights/prompt.ts). The sibling guard in reports/monthly.spec.ts covers
		// buildPeriodReport, which is only ONE of the two paths from `transactions` to here. The
		// other is getFlaggedCategoryLabels, and a future edit enriching it would keep that guard
		// green while widening what leaves the machine. Assert at the boundary, not one level in.
		//
		// includeLabels: true deliberately, which is the worst case: it is the mode where real
		// user-authored text is allowed through, so it is the mode a tag would ride out on.
		const tagged = transactions.map((transaction) => ({
			...transaction,
			tags: ['Portugal']
		})) as unknown as Transaction[];

		const monthlySummary = summarizeBudgetTransactions(
			tagged,
			[{ category: 'Logement', limitCents: 100_000 }],
			'2026-06'
		);
		const summary = buildTransactionSummary(tagged, monthlySummary, undefined, {
			includeLabels: true
		});

		expect(JSON.stringify(summary)).not.toContain('Portugal');

		// Whole words, not substrings: a naive contains('tag') matches "percenTAGe".
		const tagLikeKeys = collectKeys(summary).filter((key) =>
			key
				.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
				.toLowerCase()
				.split(' ')
				.some((word) => word === 'tag' || word === 'tags')
		);
		expect(tagLikeKeys).toEqual([]);

		// Guards the guard: the two checks above pass trivially on an empty payload.
		expect(summary.flaggedCategoryLabels).toBeDefined();
	});
});

describe('buildTransactionSummary - includeLabels', () => {
	it('n’inclut aucun libellé de transaction quand includeLabels est omis', () => {
		expect.assertions(2);

		const monthlySummary = summarizeBudgetTransactions(
			transactions,
			[{ category: 'Logement', limitCents: 100_000 }],
			'2026-06'
		);
		const summary = buildTransactionSummary(transactions, monthlySummary);

		expect(summary.flaggedCategoryLabels).toBeUndefined();
		expect(JSON.stringify(summary)).not.toContain('Loyer juin');
	});

	it('redige aussi les libellés (même anonymisés) des plus grosses dépenses et des paiements récurrents quand includeLabels est omis', () => {
		expect.assertions(2);

		const monthlySummary = summarizeBudgetTransactions(transactions, [], '2026-06');
		const summary = buildTransactionSummary(transactions, monthlySummary);

		expect(summary.largestExpenses.length).toBeGreaterThan(0);
		expect(
			summary.largestExpenses.every((expense) => expense.label === 'Expense') &&
				summary.recurringPayments.every((payment) => payment.label === 'Recurring payment')
		).toBe(true);
	});

	it('n’inclut aucun libellé quand includeLabels vaut false', () => {
		expect.assertions(1);

		const monthlySummary = summarizeBudgetTransactions(
			transactions,
			[{ category: 'Logement', limitCents: 100_000 }],
			'2026-06'
		);
		const summary = buildTransactionSummary(transactions, monthlySummary, undefined, {
			includeLabels: false
		});

		expect(summary.flaggedCategoryLabels).toBeUndefined();
	});

	it('inclut les libellés des dépenses des catégories signalées quand includeLabels vaut true', () => {
		expect.assertions(4);

		const monthlySummary = summarizeBudgetTransactions(
			transactions,
			[
				{ category: 'Logement', limitCents: 100_000 },
				{ category: 'Alimentation', limitCents: 100_000 }
			],
			'2026-06'
		);
		const summary = buildTransactionSummary(transactions, monthlySummary, undefined, {
			includeLabels: true
		});

		// Logement est over_budget (125 000 > 100 000), Alimentation reste ok (15 000 < 80 000).
		expect(summary.flaggedCategoryLabels).toBeDefined();
		expect(summary.flaggedCategoryLabels).toHaveLength(1);
		expect(summary.flaggedCategoryLabels?.[0].category).toBe('Logement');
		expect(summary.flaggedCategoryLabels?.[0].labels).toEqual([
			'Loyer juin',
			'Assurance habitation'
		]);
	});

	it('limite les libellés inclus aux 3 plus grosses dépenses de la catégorie signalée', () => {
		expect.assertions(2);

		const manyExpenses: Transaction[] = [
			{
				id: 'income',
				date: '2026-06-01',
				label: 'Salaire',
				amountCents: 300_000,
				type: 'income',
				category: 'Revenus',
				source: 'manual'
			},
			{
				id: 'e1',
				date: '2026-06-02',
				label: 'Dépense A',
				amountCents: -10_000,
				type: 'expense',
				category: 'Loisirs',
				source: 'manual'
			},
			{
				id: 'e2',
				date: '2026-06-03',
				label: 'Dépense B',
				amountCents: -40_000,
				type: 'expense',
				category: 'Loisirs',
				source: 'manual'
			},
			{
				id: 'e3',
				date: '2026-06-04',
				label: 'Dépense C',
				amountCents: -30_000,
				type: 'expense',
				category: 'Loisirs',
				source: 'manual'
			},
			{
				id: 'e4',
				date: '2026-06-05',
				label: 'Dépense D',
				amountCents: -20_000,
				type: 'expense',
				category: 'Loisirs',
				source: 'manual'
			}
		];
		const monthlySummary = summarizeBudgetTransactions(
			manyExpenses,
			[{ category: 'Loisirs', limitCents: 50_000 }],
			'2026-06'
		);
		const summary = buildTransactionSummary(manyExpenses, monthlySummary, undefined, {
			includeLabels: true
		});

		expect(summary.flaggedCategoryLabels?.[0].labels).toEqual([
			'Dépense B',
			'Dépense C',
			'Dépense D'
		]);
		expect(summary.flaggedCategoryLabels?.[0].labels).toHaveLength(3);
	});

	it('n’inclut pas les catégories dont le budget est respecté (status ok)', () => {
		expect.assertions(1);

		const monthlySummary = summarizeBudgetTransactions(
			transactions,
			[{ category: 'Alimentation', limitCents: 100_000 }],
			'2026-06'
		);
		const summary = buildTransactionSummary(transactions, monthlySummary, undefined, {
			includeLabels: true
		});

		expect(summary.flaggedCategoryLabels).toEqual([]);
	});
});
