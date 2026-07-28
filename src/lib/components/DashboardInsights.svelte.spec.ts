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
		render(DashboardInsights, {
			insights: alertInsights,
			aiAdvice: null,
			aiAllowed: false,
			categories: []
		});

		const toggle = page.getByRole('button', { name: m.dashboard_insights_heading() });
		await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');

		const content = document.getElementById('dashboard-insights-content');
		expect(content?.className).toContain('hidden');
	});

	it('reveals the insights content when the toggle is clicked', async () => {
		render(DashboardInsights, {
			insights: alertInsights,
			aiAdvice: null,
			aiAllowed: false,
			categories: []
		});

		const toggle = page.getByRole('button', { name: m.dashboard_insights_heading() });
		await toggle.click();

		await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
		const content = document.getElementById('dashboard-insights-content');
		expect(content?.className).not.toContain('hidden');
		await expect.element(page.getByText('Alimentation')).toBeInTheDocument();
	});

	it('renders nothing for the insights section when there is no content', async () => {
		render(DashboardInsights, {
			insights: emptyInsights,
			aiAdvice: null,
			aiAllowed: false,
			categories: []
		});

		expect(document.getElementById('dashboard-insights-content')).toBeNull();
	});

	it('never renders both AI cards at once, even if the caller passes a contradictory combination', async () => {
		// localAiUnavailable=true together with non-empty local-llm advice shouldn't happen per
		// the server contract, but the component must not rely on that alone — advice wins.
		render(DashboardInsights, {
			insights: emptyInsights,
			aiAdvice: {
				insights: [
					{
						id: '1',
						source: 'local-llm',
						title: 'Réduisez vos abonnements',
						message: 'Détail',
						severity: 'info',
						category: 'spending'
					}
				],
				unavailable: true
			},
			aiAllowed: true,
			categories: []
		});

		const adviceToggle = page.getByRole('button', {
			name: m.dashboard_insights_ai_badge(),
			exact: false
		});
		await expect.element(adviceToggle).toHaveTextContent('Réduisez vos abonnements');
		expect(page.getByText(m.dashboard_insights_ai_unavailable_title()).elements()).toHaveLength(0);
	});

	it('shows the pending placeholder while the streamed advice has not resolved', async () => {
		render(DashboardInsights, {
			insights: emptyInsights,
			// Never resolves: the component must show the pending state rather than nothing.
			aiAdvice: new Promise<never>(() => {}),
			aiAllowed: true,
			categories: []
		});

		await expect.element(page.getByText(m.dashboard_insights_ai_pending())).toBeInTheDocument();
	});

	it('replaces the placeholder with the advice once it resolves', async () => {
		render(DashboardInsights, {
			insights: emptyInsights,
			aiAdvice: Promise.resolve({
				insights: [
					{
						id: '1',
						source: 'local-llm' as const,
						title: 'Réduisez vos abonnements',
						message: 'Détail',
						severity: 'info' as const,
						category: 'spending' as const
					}
				],
				unavailable: false
			}),
			aiAllowed: true,
			categories: []
		});

		await expect
			.element(page.getByRole('button', { name: m.dashboard_insights_ai_badge(), exact: false }))
			.toHaveTextContent('Réduisez vos abonnements');
		expect(page.getByText(m.dashboard_insights_ai_pending()).elements()).toHaveLength(0);
	});

	it('shows the unavailable card when the streamed advice resolves unavailable', async () => {
		render(DashboardInsights, {
			insights: emptyInsights,
			aiAdvice: Promise.resolve({ insights: [], unavailable: true }),
			aiAllowed: true,
			categories: []
		});

		await expect
			.element(page.getByText(m.dashboard_insights_ai_unavailable_title()))
			.toBeInTheDocument();
	});

	it('renders no AI section at all when the feature is off, pending or not', async () => {
		render(DashboardInsights, {
			insights: emptyInsights,
			aiAdvice: new Promise<never>(() => {}),
			aiAllowed: false,
			categories: []
		});

		expect(page.getByText(m.dashboard_insights_ai_pending()).elements()).toHaveLength(0);
		expect(page.getByText(m.dashboard_insights_ai_badge()).elements()).toHaveLength(0);
	});
});
