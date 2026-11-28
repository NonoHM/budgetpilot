import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import * as m from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import { formatCents } from '$lib/domain/budget';
import { formatShortDate } from '$lib/domain/dateFormat';
import DashboardInsights from './DashboardInsights.svelte';
import type { DashboardInsights as DashboardInsightsData } from '$lib/server/dashboard/insights';

const alertInsights: DashboardInsightsData = {
	alerts: [
		{
			category: 'Alimentation',
			status: 'near_limit',
			spentCents: 24000,
			limitCents: 25000,
			remainingCents: 1000,
			remainingDays: 5,
			dailyPaceCents: 200,
			topExpenses: []
		}
	],
	alertOverflowCount: 0,
	unusualSpending: null,
	uncategorizedCount: 0
};

const emptyInsights: DashboardInsightsData = {
	alerts: [],
	alertOverflowCount: 0,
	unusualSpending: null,
	uncategorizedCount: 0
};

describe('DashboardInsights.svelte', () => {
	it('keeps the insights content collapsed by default when there is content to show', async () => {
		await render(DashboardInsights, {
			insights: alertInsights
		});

		const toggle = page.getByRole('button', { name: m.dashboard_insights_heading() });
		await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');

		const content = document.getElementById('dashboard-insights-content');
		expect(content?.className).toContain('hidden');
	});

	it('reveals the insights content when the toggle is clicked', async () => {
		await render(DashboardInsights, {
			insights: alertInsights
		});

		const toggle = page.getByRole('button', { name: m.dashboard_insights_heading() });
		await toggle.click();

		await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
		const content = document.getElementById('dashboard-insights-content');
		expect(content?.className).not.toContain('hidden');
		await expect.element(page.getByText('Alimentation')).toBeInTheDocument();
	});

	it('lists what drove an alert, one row per contributor, in the order the server ranked them', async () => {
		const topExpenses = [
			{ label: 'SUPERMARCHE DU PORT', date: '2026-03-14', amountCents: -9050 },
			{ label: 'BOULANGERIE', date: '2026-03-02', amountCents: -2000 },
			{ label: 'MARCHE', date: '2026-03-09', amountCents: -1000 }
		];
		await render(DashboardInsights, {
			insights: { ...alertInsights, alerts: [{ ...alertInsights.alerts[0], topExpenses }] }
		});
		await page.getByRole('button', { name: m.dashboard_insights_heading() }).click();

		const list = page.getByRole('list', { name: m.dashboard_insights_top_expenses() });
		await expect.element(list).toBeVisible();
		const normalise = (text: string | null) => (text ?? '').replace(/\s+/g, ' ').trim();
		// The whole row is compared, not fragments: a doubled or missing part must turn this red.
		const rows = list
			.getByRole('listitem')
			.elements()
			.map((row) => normalise(row.textContent));
		expect(rows).toEqual(
			topExpenses.map((expense) =>
				normalise(
					`${expense.label} ${formatShortDate(expense.date, getLocale())} ${formatCents(expense.amountCents)}`
				)
			)
		);
	});

	it('shows no contributor list for an alert with no contributors', async () => {
		await render(DashboardInsights, { insights: alertInsights });
		await page.getByRole('button', { name: m.dashboard_insights_heading() }).click();

		await expect.element(page.getByText('Alimentation')).toBeVisible();
		expect(
			page.getByRole('list', { name: m.dashboard_insights_top_expenses() }).elements()
		).toHaveLength(0);
	});

	it('renders nothing for the insights section when there is no content', async () => {
		await render(DashboardInsights, {
			insights: emptyInsights
		});

		expect(document.getElementById('dashboard-insights-content')).toBeNull();
	});
});
