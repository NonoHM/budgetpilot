import { describe, expect, it } from 'vitest';
import { takeawayDot, takeawayText } from './takeawayLabels';
import { buildMonthlyReport } from '$lib/server/reports/monthly';
import type { Transaction } from '$lib/domain/transaction';

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

		const report = buildMonthlyReport(transactions, '2026-06');
		const topCategoryTakeaway = report.takeaways.find((t) => t.code === 'top_category');

		expect(topCategoryTakeaway).toBeDefined();
		expect(topCategoryTakeaway?.code).toBe('top_category');
		expect(takeawayDot(topCategoryTakeaway!.code)).not.toBe('bg-indigo-600');
	});
});

describe('takeawayText', () => {
	it('resolves the top_category takeaway text by passing the category through the injected displayCategory', () => {
		expect.assertions(1);

		const text = takeawayText(
			{ code: 'top_category', category: 'Investissement', percent: '80 %' },
			(name) => `[${name}]`
		);

		expect(text).toBe(
			'**[Investissement]** est le premier poste de dépenses avec 80 % des dépenses.'
		);
	});

	it('resolves the investment takeaway text without depending on displayCategory', () => {
		expect.assertions(1);

		const text = takeawayText({ code: 'investment' }, (name) => name);

		expect(text).toBe(
			'Une part des sorties correspond à des investissements et non à de la consommation.'
		);
	});
});
