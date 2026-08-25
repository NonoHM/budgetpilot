import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import * as m from '$lib/paraglide/messages';
import DashboardInsights from './DashboardInsights.svelte';
import type { DashboardInsights as DashboardInsightsData } from '$lib/server/dashboard/insights';
import type { LocalLlmFailureCode } from '$lib/domain/failureCodes';

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
			aiAllowed: false
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
			aiAllowed: false
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
			aiAllowed: false
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
			aiAllowed: true
		});

		const adviceToggle = page.getByRole('button', {
			name: m.dashboard_insights_ai_badge(),
			exact: false
		});
		await expect.element(adviceToggle).toHaveTextContent('Réduisez vos abonnements');
		expect(page.getByText(m.dashboard_insights_ai_unreachable_title()).elements()).toHaveLength(0);
	});

	it('shows the pending placeholder while the streamed advice has not resolved', async () => {
		render(DashboardInsights, {
			insights: emptyInsights,
			// Never resolves: the component must show the pending state rather than nothing.
			aiAdvice: new Promise<never>(() => {}),
			aiAllowed: true
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
			aiAllowed: true
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
			aiAllowed: true
		});

		await expect
			.element(page.getByText(m.dashboard_insights_ai_unreachable_title()))
			.toBeInTheDocument();
	});

	it('renders no AI section at all when the feature is off, pending or not', async () => {
		render(DashboardInsights, {
			insights: emptyInsights,
			aiAdvice: new Promise<never>(() => {}),
			aiAllowed: false
		});

		expect(page.getByText(m.dashboard_insights_ai_pending()).elements()).toHaveLength(0);
		expect(page.getByText(m.dashboard_insights_ai_badge()).elements()).toHaveLength(0);
	});
});

/**
 * The AI card names WHICH of the five states it is in (#524).
 *
 * One title, « Assistant IA indisponible », used to cover all five, and it reads as transient for
 * four states that are not. The reported bug was the fifth: a cold model load, which IS transient
 * and was the only one the sentence happened to fit.
 *
 * `satisfies Record<LocalLlmFailureCode, ...>` rather than a plain array, and that is the point of
 * the shape: adding a code to the union without adding a row here stops `npm run check`, so this
 * table cannot silently fall behind the component's own map.
 */
const AI_FAILURE_STATES = {
	cold_start: {
		title: () => m.dashboard_insights_ai_cold_start_title(),
		reason: () => m.dashboard_insights_ai_cold_start_message(),
		showsConfigurationLink: false
	},
	unreachable: {
		title: () => m.dashboard_insights_ai_unreachable_title(),
		reason: () => m.dashboard_insights_ai_unreachable_reason(),
		showsConfigurationLink: true
	},
	not_configured: {
		title: () => m.dashboard_insights_ai_not_configured_title(),
		reason: () => m.dashboard_insights_ai_not_configured_reason(),
		showsConfigurationLink: true
	},
	model_unavailable: {
		title: () => m.dashboard_insights_ai_model_unavailable_title(),
		reason: () => m.dashboard_insights_ai_model_unavailable_reason(),
		showsConfigurationLink: true
	},
	response_unusable: {
		title: () => m.dashboard_insights_ai_response_unusable_title(),
		reason: () => m.dashboard_insights_ai_response_unusable_reason(),
		showsConfigurationLink: true
	},
	response_truncated: {
		title: () => m.dashboard_insights_ai_response_truncated_title(),
		reason: () => m.dashboard_insights_ai_response_truncated_reason(),
		showsConfigurationLink: true
	}
} satisfies Record<
	LocalLlmFailureCode,
	{ title: () => string; reason: () => string; showsConfigurationLink: boolean }
>;

const AI_FAILURE_CODES = Object.keys(AI_FAILURE_STATES) as LocalLlmFailureCode[];

describe('DashboardInsights.svelte AI failure states', () => {
	it('covers all six codes, so a shrunken table cannot report a clean run', () => {
		// The absolute figure beside the coverage claim. `it.each` over an empty or shortened list
		// passes by running nothing, and a green suite that exercised one state reads exactly like a
		// green suite that exercised five.
		expect(AI_FAILURE_CODES).toHaveLength(6);
		expect(AI_FAILURE_CODES).toEqual([
			'cold_start',
			'unreachable',
			'not_configured',
			'model_unavailable',
			'response_unusable',
			'response_truncated'
		]);
	});

	it.each(AI_FAILURE_CODES)(
		'renders the %s title and reason rather than one generic sentence',
		async (code) => {
			render(DashboardInsights, {
				insights: emptyInsights,
				aiAdvice: Promise.resolve({ insights: [], unavailable: true, failureCode: code }),
				aiAllowed: true
			});

			await expect.element(page.getByText(AI_FAILURE_STATES[code].title())).toBeInTheDocument();
			await expect.element(page.getByText(AI_FAILURE_STATES[code].reason())).toBeInTheDocument();
		}
	);

	it('gives the six states six DIFFERENT titles, which is the property the defect violated', () => {
		// Separates "each code renders a title" from "each code renders ITS title". The per-code test
		// above passes if every row of the table names the same string, which is precisely the state
		// this card shipped in: five codes, one sentence, five green assertions.
		const titles = AI_FAILURE_CODES.map((code) => AI_FAILURE_STATES[code].title());
		expect(new Set(titles).size).toBe(6);

		const reasons = AI_FAILURE_CODES.map((code) => AI_FAILURE_STATES[code].reason());
		expect(new Set(reasons).size).toBe(6);
	});

	it('offers the configuration link on every state EXCEPT a cold start', async () => {
		expect.assertions(2);

		// The one behaviour the whole card was filed for. A model still loading is the single state
		// where there is nothing to configure, so pointing the reader at Settings is advice about the
		// wrong thing; its own sentence tells them to reload instead, which is true because the
		// streamed promise has already resolved and the card will not update by itself.
		render(DashboardInsights, {
			insights: emptyInsights,
			aiAdvice: Promise.resolve({
				insights: [],
				unavailable: true,
				failureCode: 'cold_start' as const
			}),
			aiAllowed: true
		});

		await expect
			.element(page.getByText(m.dashboard_insights_ai_cold_start_title()))
			.toBeInTheDocument();
		expect(page.getByText(m.dashboard_insights_ai_check_configuration()).elements()).toHaveLength(
			0
		);
	});

	it('DOES offer the configuration link when the model is unreachable, so the exception is one state and not the rule', async () => {
		expect.assertions(1);

		// The positive half of the assertion above. Without it, deleting the link from every state
		// would leave the cold-start test green, and a check that only ever observes an absence is
		// satisfied by a card that renders nothing at all.
		render(DashboardInsights, {
			insights: emptyInsights,
			aiAdvice: Promise.resolve({
				insights: [],
				unavailable: true,
				failureCode: 'unreachable' as const
			}),
			aiAllowed: true
		});

		await expect
			.element(page.getByText(m.dashboard_insights_ai_check_configuration()))
			.toBeInTheDocument();
	});
});
