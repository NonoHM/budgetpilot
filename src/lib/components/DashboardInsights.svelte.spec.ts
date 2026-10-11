import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import * as m from '$lib/paraglide/messages';
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

	it('renders nothing for the insights section when there is no content', async () => {
		await render(DashboardInsights, {
			insights: emptyInsights
		});

		expect(document.getElementById('dashboard-insights-content')).toBeNull();
	});
});
