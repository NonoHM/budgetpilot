import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import './layout.css';
import * as m from '$lib/paraglide/messages';
import Page from './+page.svelte';
import type { ActionData, PageData } from './$types';

/**
 * Task 3 (B5a), fix round 1: `dashboard-mode.spec.ts` originally asserted this gate by reading
 * `+page.svelte` off disk and matching a literal `{#if ...}` substring — a change-detector that
 * would stay green with a correct-looking string and a broken runtime, and go red on a harmless
 * rename with no behavioural regression at all. This file replaces that assertion with a real
 * render, following the precedent in `budgets/page.svelte.spec.ts`,
 * `net-worth/page.svelte.spec.ts` and `upcoming-bills/page.svelte.spec.ts`.
 *
 * `hasDashboardData` (see `+page.svelte`) keys on the CURRENT PERIOD's transactions/budgets/goals.
 * `showDashboardBody` widens that with `data.upcomingBills.hasStreams`, which is computed over the
 * detector's own 12-month window and is therefore independent of the period — a user with
 * detected recurring streams but no activity this period must still see the upcoming-bills widget,
 * not the dashboard's onboarding empty state.
 */

const TODAY_ISO = '2026-07-31';

const EMPTY_SUMMARY: PageData['summary'] = {
	month: '2026-07',
	incomeCents: 0,
	expenseCents: 0,
	balanceCents: 0,
	categorySummaries: []
};

const EMPTY_NATURE_ANALYSIS: PageData['natureAnalysis'] = {
	incomeCents: 0,
	spendingCents: 0,
	investmentCents: 0,
	transferCents: 0,
	refundCents: 0,
	feeCents: 0,
	uncategorizedCents: 0
};

const EMPTY_INSIGHTS: PageData['insights'] = {
	alerts: [],
	alertOverflowCount: 0,
	unusualSpending: null,
	uncategorizedCount: 0
};

const EMPTY_FORECAST: PageData['cashFlowForecast'] = {
	hasBalanceAnchor: false,
	days: [],
	todayIndex: 0,
	flows: [],
	emptyState: 'none-detected'
};

/**
 * Typed factory rather than an object literal per test: TypeScript narrows a literal's array
 * fields precisely, so a spec that later relies on a wider type only fails `npm run check`, not
 * `vitest`. See CLAUDE.md, "a green vitest says nothing about types".
 */
function buildData(
	overrides: {
		transactions?: PageData['transactions'];
		budgets?: PageData['budgets'];
		savingsGoals?: PageData['savingsGoals'];
		upcomingBillsHasStreams?: boolean;
		cashFlowForecast?: PageData['cashFlowForecast'];
	} = {}
): PageData {
	const {
		transactions = [],
		budgets = [],
		savingsGoals = [],
		upcomingBillsHasStreams = false,
		cashFlowForecast = EMPTY_FORECAST
	} = overrides;

	return {
		user: { email: 'user@example.com', role: 'USER' } as PageData['user'],
		categoryOptions: [],
		categories: [],
		month: '2026-07',
		period: {
			key: 'this-month',
			label: 'juillet 2026',
			from: new Date('2026-07-01T00:00:00.000Z'),
			to: new Date('2026-08-01T00:00:00.000Z'),
			fromDate: '2026-07-01',
			toDate: '2026-08-01',
			budgetMonth: '2026-07'
		},
		budgetSummaryAvailable: true,
		periodQuery: 'period=this-month',
		transactions,
		budgets,
		summary: EMPTY_SUMMARY,
		natureAnalysis: EMPTY_NATURE_ANALYSIS,
		aiAdvice: null,
		aiAllowed: false,
		recentTransactions: transactions.slice(0, 10),
		insights: EMPTY_INSIGHTS,
		savingsGoals,
		savingsGoalsOverflowCount: 0,
		cashFlowForecast,
		upcomingBills: {
			rows: [],
			overdueCount: 0,
			remainingExpenseCents: 0,
			hasStreams: upcomingBillsHasStreams,
			todayIso: TODAY_ISO
		}
	} as PageData;
}

describe('/ dashboard — upcoming-bills widget vs the onboarding gate (Task 3, B5a)', () => {
	it('renders the widget when the period has no data but a stream was detected', async () => {
		const screen = render(Page, {
			data: buildData({ upcomingBillsHasStreams: true }),
			form: null as ActionData
		});

		// The widget's own heading — only `UpcomingBillsCard` renders this string.
		await expect.element(screen.getByText('Échéances à venir')).toBeInTheDocument();
		// And the onboarding empty state must NOT also be showing (no two empty states stacked).
		expect(screen.container.textContent).not.toContain('Importez votre premier relevé');
	});

	it('shows the onboarding empty state, not the widget, when neither the period nor the detector has anything', async () => {
		const screen = render(Page, {
			data: buildData({ upcomingBillsHasStreams: false }),
			form: null as ActionData
		});

		expect(screen.container.textContent).not.toContain('Échéances à venir');
		await expect.element(screen.getByText('Importez votre premier relevé')).toBeInTheDocument();
	});

	/**
	 * The gate above widened the BODY, which also removed the onboarding `EmptyState` — and that
	 * panel carried the dashboard's only "/import" call to action. The header's Import button was
	 * left on `hasDashboardData`, so this exact state (streams, no current-period activity) had the
	 * widget, the full two-column body, and no way to import from the dashboard at all. The top nav
	 * goes to `/imports`, the history page, not `/import`.
	 */
	it('keeps an import entry point reachable when only a detected stream opens the body', async () => {
		const screen = render(Page, {
			data: buildData({ upcomingBillsHasStreams: true }),
			form: null as ActionData
		});

		const importLink = screen.container.querySelector('a[href="/import"]');
		expect(importLink).not.toBeNull();
	});

	it('still renders the widget in the ordinary populated case', async () => {
		const screen = render(Page, {
			data: buildData({
				transactions: [
					{
						id: 't1',
						date: '2026-07-15',
						label: 'Salaire',
						amountCents: 250_000,
						category: 'Revenus',
						source: 'manual'
					}
				],
				upcomingBillsHasStreams: true
			}),
			form: null as ActionData
		});

		await expect.element(screen.getByText('Échéances à venir')).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain('Importez votre premier relevé');
	});
});

/**
 * Task 2 of the detection-window-upper-bound chantier: `emptyState` distinguishes "nothing
 * detected yet" from "detected streams have all gone stale", so the forecast card must render a
 * different EmptyState for each rather than collapsing both into one sentence. Asserted against
 * the Paraglide message, never a hardcoded French literal (CLAUDE.md).
 */
describe('/ dashboard forecast card — split empty-state copy (Task 2)', () => {
	it("renders the 'nothing detected yet' copy when emptyState is 'none-detected'", async () => {
		const screen = render(Page, {
			data: buildData({
				upcomingBillsHasStreams: true,
				cashFlowForecast: { ...EMPTY_FORECAST, emptyState: 'none-detected' }
			}),
			form: null as ActionData
		});

		await expect.element(screen.getByText(m.dashboard_forecast_empty_title())).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain(m.dashboard_forecast_stale_title());
	});

	it("renders the 'gone stale' copy when emptyState is 'all-stale'", async () => {
		const screen = render(Page, {
			data: buildData({
				upcomingBillsHasStreams: true,
				cashFlowForecast: { ...EMPTY_FORECAST, emptyState: 'all-stale' }
			}),
			form: null as ActionData
		});

		await expect.element(screen.getByText(m.dashboard_forecast_stale_title())).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain(m.dashboard_forecast_empty_title());
	});

	/**
	 * Fix round 1, IMPORTANT #1: the CTA (`dashboard_forecast_empty_cta`, linking to
	 * `/reports#annexe-recurrences`) is not a remedy — it's "here is what was detected" — so both
	 * empty branches keep it. `all-stale` in particular means at least one flow WAS
	 * reliable-confirmed, so the annexe table it links to certainly has rows.
	 */
	it("renders the annexe-recurrences CTA in the 'none-detected' branch", async () => {
		const screen = render(Page, {
			data: buildData({
				upcomingBillsHasStreams: true,
				cashFlowForecast: { ...EMPTY_FORECAST, emptyState: 'none-detected' }
			}),
			form: null as ActionData
		});

		const cta = screen.container.querySelector('a[href="/reports#annexe-recurrences"]');
		expect(cta).not.toBeNull();
		expect(cta?.textContent).toBe(m.dashboard_forecast_empty_cta());
	});

	it("renders the same annexe-recurrences CTA in the 'all-stale' branch", async () => {
		const screen = render(Page, {
			data: buildData({
				upcomingBillsHasStreams: true,
				cashFlowForecast: { ...EMPTY_FORECAST, emptyState: 'all-stale' }
			}),
			form: null as ActionData
		});

		const cta = screen.container.querySelector('a[href="/reports#annexe-recurrences"]');
		expect(cta).not.toBeNull();
		expect(cta?.textContent).toBe(m.dashboard_forecast_empty_cta());
	});

	/**
	 * Fix round 1, IMPORTANT #2: the populated branch now gates on `cashFlowForecast.emptyState
	 * === null`, the total discriminator, rather than a separately re-derived
	 * `flows.some(f => f.feedsProjection)` boolean that could silently diverge from it. This is the
	 * render path that coupling used to guard and is otherwise unexercised by the two tests above.
	 */
	it('renders the populated forecast (chart, not an empty state) when emptyState is null', async () => {
		const screen = render(Page, {
			data: buildData({
				upcomingBillsHasStreams: true,
				cashFlowForecast: {
					hasBalanceAnchor: true,
					todayIndex: 0,
					days: [
						{ date: '2026-07-31', balanceCents: 100_000, events: [] },
						{ date: '2026-08-01', balanceCents: 98_601, events: [] }
					],
					flows: [
						{
							category: 'Abonnements',
							direction: 'expense',
							cadence: 'monthly',
							status: 'confirmed',
							confidence: 'high',
							label: 'Netflix',
							averageAmountCents: -1_399,
							lastDate: '2026-07-01',
							feedsProjection: true
						}
					],
					emptyState: null
				}
			}),
			form: null as ActionData
		});

		await expect
			.element(screen.getByText(m.dashboard_forecast_kpi_delta_suffix()))
			.toBeInTheDocument();
		expect(screen.container.textContent).not.toContain(m.dashboard_forecast_empty_title());
		expect(screen.container.textContent).not.toContain(m.dashboard_forecast_stale_title());
	});
});
