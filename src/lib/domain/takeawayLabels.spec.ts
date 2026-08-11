import { describe, expect, it } from 'vitest';
import { takeawayDot, takeawayText } from './takeawayLabels';
import { buildMonthlyReport } from '$lib/server/reports/monthly';
import type { Transaction } from '$lib/domain/transaction';
import { allocationsOf, type CategoryAllocation } from '$lib/domain/allocation';
import { getEffectiveTransactionNature } from '$lib/server/transactions/nature';

/**
 * Derives the MONEY view from the fixture's IDENTITY view, by calling the canonical helpers rather
 * than restating the remainder rule or the nature default (see CLAUDE.md). The fixture below is
 * unsplit, so this always yields exactly one allocation per transaction, carrying its whole amount.
 */
function toAllocations(transactions: Transaction[]): CategoryAllocation[] {
	return transactions.flatMap((transaction) =>
		allocationsOf({
			...transaction,
			nature: transaction.nature ?? getEffectiveTransactionNature(transaction, new Map()).nature
		})
	);
}

describe('takeawayDot', () => {
	it('ne prend jamais la couleur "investment" (indigo) pour un takeaway top_category', () => {
		expect.assertions(2);

		// Regression: the old code did substring matching on the displayed text
		// ("investissement" in the label), so a top_category named "Investissement"
		// incorrectly took on the color of the investment takeaway.
		expect(takeawayDot('top_category')).not.toBe('bg-indigo-600');
		expect(takeawayDot('top_category')).toBe('bg-zinc-400');
	});

	it('reserves the indigo color for the investment code only', () => {
		expect.assertions(1);

		expect(takeawayDot('investment')).toBe('bg-indigo-600');
	});

	it('associe les couleurs attendues aux autres codes', () => {
		expect.assertions(4);

		expect(takeawayDot('balance_positive')).toBe('bg-emerald-600');
		expect(takeawayDot('expense_decreasing')).toBe('bg-emerald-600');
		expect(takeawayDot('balance_negative')).toBe('bg-rose-600');
		expect(takeawayDot('expense_increasing')).toBe('bg-rose-600');
	});
});

describe('takeawayDot — category name collision (end-to-end via buildMonthlyReport)', () => {
	it('a top category named "Investissement" keeps the top_category code, not investment, and not the indigo color', () => {
		expect.assertions(3);

		const transactions: Transaction[] = [
			{
				id: 'tx-1',
				date: '2026-06-05',
				label: 'Versement PEA',
				amountCents: -50_000,
				type: 'expense',
				category: 'Investissement',
				source: 'manual'
			},
			{
				id: 'tx-2',
				date: '2026-06-10',
				label: 'Salaire',
				amountCents: 200_000,
				type: 'income',
				category: 'Revenus',
				source: 'manual'
			}
		];

		const report = buildMonthlyReport(transactions, toAllocations(transactions), '2026-06');
		const topCategoryTakeaway = report.takeaways.find((t) => t.code === 'top_category');

		expect(topCategoryTakeaway).toBeDefined();
		expect(topCategoryTakeaway?.code).toBe('top_category');
		expect(takeawayDot(topCategoryTakeaway!.code)).not.toBe('bg-indigo-600');
	});
});

describe('takeawayText', () => {
	it('resolves the top_category takeaway text with the category name as stored (#162)', () => {
		expect.assertions(1);

		// The display function used to be INJECTED here, and this test proved the injection by
		// passing `(name) => `[${name}]`` and looking for the brackets. That was a test of the
		// wiring rather than of the output, and it could not fail if the wiring were replaced by
		// anything else that returned a string. The assertion is now absolute: the real function
		// runs, and the category appears under the name the database holds.
		const text = takeawayText({
			code: 'top_category',
			category: 'Investissement',
			percent: '80 %'
		});

		expect(text).toBe(
			'**Investissement** est le premier poste de dépenses avec 80 % des dépenses.'
		);
	});

	it('resolves the investment takeaway text, which names no category at all', () => {
		expect.assertions(1);

		const text = takeawayText({ code: 'investment' });

		expect(text).toBe(
			'Une part des sorties correspond à des investissements et non à de la consommation.'
		);
	});
});
