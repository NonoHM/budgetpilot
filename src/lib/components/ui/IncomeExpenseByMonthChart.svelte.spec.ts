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

	// Separates « newest six, then all thirteen on request » from a list that drops or reorders months.
	it('lists the newest six months first, the one in progress marked, and all thirteen on request', async () => {
		render(IncomeExpenseByMonthChart, { months });
		const rows = () => [...document.querySelectorAll('[data-month-row]')];
		const collapse = (text: string | null) => (text ?? '').replace(/\s+/g, ' ').trim();
		await expect
			.element(page.getByRole('button', { name: 'Afficher les 13 mois' }))
			.toBeInTheDocument();
		expect(rows().map((row) => row.getAttribute('data-month-row'))).toEqual([
			'2026-01',
			'2025-12',
			'2025-11',
			'2025-10',
			'2025-09',
			'2025-08'
		]);
		expect(
			collapse(rows()[0].querySelector('div')!.firstElementChild!.parentElement!.textContent)
		).toMatch(/^janvier 2026 · en cours /);
		await page.getByRole('button', { name: 'Afficher les 13 mois' }).click();
		await expect.element(page.getByRole('button', { name: 'Afficher moins' })).toBeInTheDocument();
		expect(rows()).toHaveLength(13);
		expect(rows().at(-1)!.getAttribute('data-month-row')).toBe('2025-01');
	});

	it('says there is nothing to show when the thirteen months are empty', async () => {
		render(IncomeExpenseByMonthChart, {
			months: buildIncomeExpenseByMonth([], reportMonths('2026-01-15'))
		});
		await expect
			.element(page.getByText('Aucun revenu ni aucune dépense sur les 12 derniers mois.'))
			.toBeInTheDocument();
		expect(document.querySelectorAll('[data-month-row]')).toHaveLength(0);
	});
});
