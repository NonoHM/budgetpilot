import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { formatCents } from '$lib/domain/budget';
import type { CategoryAllocation } from '$lib/domain/allocation';
import { buildIncomeExpenseByMonth, reportMonths } from '$lib/domain/incomeExpenseByMonth';
import IncomeExpenseByMonthChart from './IncomeExpenseByMonthChart.svelte';

// #418. Tests run in `fr` (vitest.client.setup.ts pins the cookie).
function row(date: string, amountCents: number): CategoryAllocation {
	return {
		transactionId: date,
		date,
		category: 'Courses',
		amountCents,
		nature: amountCents > 0 ? 'income' : 'spending',
		kind: amountCents > 0 ? 'income' : 'expense',
		transferPaired: false
	};
}

const months = buildIncomeExpenseByMonth(
	[
		row('2025-11-02', 200_000),
		row('2025-11-20', -150_000),
		row('2025-12-02', 100_000),
		row('2025-12-15', -130_000),
		// In progress: counted in its bar and its row, never in the twelve-month sentence.
		row('2026-01-05', -999_00)
	],
	reportMonths('2026-01-15')
);

describe('IncomeExpenseByMonthChart', () => {
	// Separates « the sentence sums the twelve whole months » from « it also sums the month in progress ».
	it('states the twelve whole months, and how many of them spent beyond income', async () => {
		render(IncomeExpenseByMonthChart, { months });
		const figure = page.getByRole('figure');
		await expect.element(figure).toBeInTheDocument();
		const caption = figure.element().querySelector('figcaption');
		// Equality, not a substring: a doubled or truncated tail must fail. Whitespace is collapsed on
		// both sides because formatCents writes narrow no-break spaces.
		const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
		expect(collapse(caption?.textContent ?? '')).toBe(
			collapse(
				`12 mois complets : ${formatCents(300_000)} entrés, ${formatCents(280_000)} sortis. Mois où les dépenses dépassent les revenus : 1.`
			)
		);
	});

	// Separates « a month opens its own rows, every kind » from « a type filter that can disagree
	// with the bar » (contradiction pass 2026-11-27: `type` filters a column, the bar reads the kind).
	it('links each month to its own first and last day, with no type filter', async () => {
		render(IncomeExpenseByMonthChart, { months });
		const links = page.getByRole('link', { name: /novembre 2025/ });
		await expect
			.element(links.first())
			.toHaveAttribute('href', '/transactions?from=2025-11-01&to=2025-11-30');
	});

	it('gives every one of the thirteen months a table row, the last one in progress', async () => {
		render(IncomeExpenseByMonthChart, { months });
		const rows = page.getByRole('table').getByRole('row');
		// One header row plus thirteen months.
		expect(rows.elements()).toHaveLength(14);
		const header = rows.nth(1).getByRole('rowheader');
		await expect.element(header).toBeInTheDocument();
		const text = (header.element().textContent ?? '').replace(/\s+/g, ' ').trim();
		expect([...text].map((char) => char.codePointAt(0)!.toString(16))).toEqual(
			[...'janv. 2026 · en cours'].map((char) => char.codePointAt(0)!.toString(16))
		);
	});

	it('says there is nothing to show when the thirteen months are empty', async () => {
		render(IncomeExpenseByMonthChart, {
			months: buildIncomeExpenseByMonth([], reportMonths('2026-01-15'))
		});
		await expect
			.element(page.getByText('Aucun revenu ni aucune dépense sur les 12 derniers mois.'))
			.toBeInTheDocument();
		expect(page.getByRole('table').elements()).toHaveLength(0);
	});
});
