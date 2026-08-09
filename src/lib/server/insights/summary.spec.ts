import { describe, expect, it } from 'vitest';
import { summarizeBudgetAllocations } from '$lib/domain/budget';
import type { Transaction } from '$lib/domain/transaction';
import { allocationsOf, type CategoryAllocation } from '$lib/domain/allocation';
import { getEffectiveTransactionNature } from '$lib/server/transactions/nature';
import { buildTransactionSummary } from './summary';

/**
 * Derives the MONEY view from the fixture's IDENTITY view, by calling the canonical helpers rather
 * than restating the remainder rule or the nature default (see CLAUDE.md). Every fixture in this
 * file is unsplit, so this always yields exactly one allocation per transaction, carrying its
 * whole amount.
 */
function toAllocations(transactions: Transaction[]): CategoryAllocation[] {
	return transactions.flatMap((transaction) =>
		allocationsOf({
			...transaction,
			nature: transaction.nature ?? getEffectiveTransactionNature(transaction, new Map()).nature
		})
	);
}

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

		const monthlySummary = summarizeBudgetAllocations(
			toAllocations(tagged),
			[{ category: 'Logement', limitCents: 100_000 }],
			'2026-06'
		);
		const summary = buildTransactionSummary(
			tagged,
			toAllocations(tagged),
			monthlySummary,
			undefined,
			{
				includeLabels: true
			}
		);

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

/**
 * A part's `note` is free text of unknown content that the user writes for themselves. It is never
 * logged, never a filter or search target, and it must never reach the model — the payload leaves
 * the process, and nothing about "the parts are only categories and amounts" is guaranteed by the
 * types once someone enriches an allocation.
 *
 * Structural on purpose, and aimed at the same chokepoint as the tag guard above rather than one
 * level in: `buildTransactionSummary`'s return value IS the prompt payload. Break-checked by
 * threading a note into the summary and watching this name it.
 */
describe('buildTransactionSummary and split notes', () => {
	it('carries no note-shaped key into the AI payload', () => {
		expect.assertions(2);

		const monthlySummary = summarizeBudgetAllocations(
			toAllocations(transactions),
			[{ category: 'Logement', limitCents: 100_000 }],
			'2026-06'
		);
		const summary = buildTransactionSummary(
			transactions,
			toAllocations(transactions),
			monthlySummary,
			undefined,
			{ includeLabels: true }
		);

		// Whole words, so `noteworthy` or `denoted` cannot be read as a hit — and both singular and
		// plural, because `Transaction.notes` is the older field of the same kind.
		const noteLikeKeys = collectKeys(summary).filter((key) =>
			key
				.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
				.toLowerCase()
				.split(' ')
				.some((word) => word === 'note' || word === 'notes')
		);
		expect(noteLikeKeys).toEqual([]);

		// Guards the guard: the check above passes trivially on an empty payload.
		expect(summary.transactionCount).toBeGreaterThan(0);
	});
});

/**
 * `expense-1` (Loyer juin, −120 000) split into a −20 000 Assurance part and a −100 000 Logement
 * remainder — the ONLY fixture in this file carrying more than one allocation per transaction id.
 */
function toAllocationsWithSplitExpense(txns: Transaction[]): CategoryAllocation[] {
	return txns.flatMap((transaction) => {
		const nature =
			transaction.nature ?? getEffectiveTransactionNature(transaction, new Map()).nature;
		if (transaction.id !== 'expense-1') return allocationsOf({ ...transaction, nature });

		return allocationsOf({ ...transaction, nature }, [
			{ category: 'Assurance', amountCents: -20_000 }
		]);
	});
}

describe('buildTransactionSummary and split indicators', () => {
	it("porte l'indicateur de répartition d'une plus grosse dépense jusqu'au payload, sous label opt-out y compris", () => {
		expect.assertions(6);

		const allocations = toAllocationsWithSplitExpense(transactions);
		const monthlySummary = summarizeBudgetAllocations(
			allocations,
			[{ category: 'Logement', limitCents: 100_000 }],
			'2026-06'
		);

		// includeLabels: true — the exact claim the badge on `/reports` makes.
		const labelled = buildTransactionSummary(transactions, allocations, monthlySummary, undefined, {
			includeLabels: true
		});
		// By amount, not by the anonymized label's exact casing (`anonymizeMerchant` title-cases it) —
		// the amount is the one figure OD-3 guarantees stays the parent's, whole.
		const labelledExpense = labelled.largestExpenses.find(
			(expense) => expense.amountCents === 120_000
		);
		expect(labelledExpense?.splitIndicator).not.toBeNull();
		expect(labelledExpense?.splitIndicator?.dominantCategory).toBe('Logement');
		expect(labelledExpense?.splitIndicator?.parts).toEqual([
			{ category: 'Assurance', amountCents: -20_000 },
			{ category: 'Logement', amountCents: -100_000 }
		]);

		// includeLabels omitted — the merchant is anonymized to 'Expense', but the category
		// breakdown is not label data (every other category-shaped field already reaches the model
		// regardless of this option), so it must still be there. Checked explicitly rather than
		// assumed from the object-spread in buildTransactionSummary (see CLAUDE.md: a green test
		// that merely spreads is not evidence the field survives on purpose).
		const anonymized = buildTransactionSummary(transactions, allocations, monthlySummary);
		const anonymizedExpense = anonymized.largestExpenses.find(
			(expense) => expense.amountCents === 120_000
		);
		expect(anonymizedExpense?.label).toBe('Expense');
		expect(anonymizedExpense?.splitIndicator).not.toBeNull();
		expect(anonymizedExpense?.splitIndicator?.dominantCategory).toBe('Logement');
	});
});

describe('buildTransactionSummary - includeLabels', () => {
	it('n’inclut aucun libellé de transaction quand includeLabels est omis', () => {
		expect.assertions(2);

		const monthlySummary = summarizeBudgetAllocations(
			toAllocations(transactions),
			[{ category: 'Logement', limitCents: 100_000 }],
			'2026-06'
		);
		const summary = buildTransactionSummary(
			transactions,
			toAllocations(transactions),
			monthlySummary
		);

		expect(summary.flaggedCategoryLabels).toBeUndefined();
		expect(JSON.stringify(summary)).not.toContain('Loyer juin');
	});

	it('redige aussi les libellés (même anonymisés) des plus grosses dépenses et des paiements récurrents quand includeLabels est omis', () => {
		expect.assertions(2);

		const monthlySummary = summarizeBudgetAllocations(toAllocations(transactions), [], '2026-06');
		const summary = buildTransactionSummary(
			transactions,
			toAllocations(transactions),
			monthlySummary
		);

		expect(summary.largestExpenses.length).toBeGreaterThan(0);
		expect(
			summary.largestExpenses.every((expense) => expense.label === 'Expense') &&
				summary.recurringPayments.every((payment) => payment.label === 'Recurring payment')
		).toBe(true);
	});

	it('n’inclut aucun libellé quand includeLabels vaut false', () => {
		expect.assertions(1);

		const monthlySummary = summarizeBudgetAllocations(
			toAllocations(transactions),
			[{ category: 'Logement', limitCents: 100_000 }],
			'2026-06'
		);
		const summary = buildTransactionSummary(
			transactions,
			toAllocations(transactions),
			monthlySummary,
			undefined,
			{
				includeLabels: false
			}
		);

		expect(summary.flaggedCategoryLabels).toBeUndefined();
	});

	it('inclut les libellés des dépenses des catégories signalées quand includeLabels vaut true', () => {
		expect.assertions(4);

		const monthlySummary = summarizeBudgetAllocations(
			toAllocations(transactions),
			[
				{ category: 'Logement', limitCents: 100_000 },
				{ category: 'Alimentation', limitCents: 100_000 }
			],
			'2026-06'
		);
		const summary = buildTransactionSummary(
			transactions,
			toAllocations(transactions),
			monthlySummary,
			undefined,
			{
				includeLabels: true
			}
		);

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
		const monthlySummary = summarizeBudgetAllocations(
			toAllocations(manyExpenses),
			[{ category: 'Loisirs', limitCents: 50_000 }],
			'2026-06'
		);
		const summary = buildTransactionSummary(
			manyExpenses,
			toAllocations(manyExpenses),
			monthlySummary,
			undefined,
			{
				includeLabels: true
			}
		);

		expect(summary.flaggedCategoryLabels?.[0].labels).toEqual([
			'Dépense B',
			'Dépense C',
			'Dépense D'
		]);
		expect(summary.flaggedCategoryLabels?.[0].labels).toHaveLength(3);
	});

	it('n’inclut pas les catégories dont le budget est respecté (status ok)', () => {
		expect.assertions(1);

		const monthlySummary = summarizeBudgetAllocations(
			toAllocations(transactions),
			[{ category: 'Alimentation', limitCents: 100_000 }],
			'2026-06'
		);
		const summary = buildTransactionSummary(
			transactions,
			toAllocations(transactions),
			monthlySummary,
			undefined,
			{
				includeLabels: true
			}
		);

		expect(summary.flaggedCategoryLabels).toEqual([]);
	});
});
