import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import './layout.css';
import * as m from '$lib/paraglide/messages';
import { formatCents } from '$lib/domain/budget';
import Page from './+page.svelte';
import type { ActionData, PageData } from './$types';

/** Same rule SplitBadge's own `detail` uses, called rather than retyped — `formatCents` puts a
 *  narrow no-break space before "€", which a hand-typed literal gets silently wrong. */
function detailOf(parts: { category: string; amountCents: number }[]): string {
	return parts
		.map((part) => `${part.category} ${formatCents(Math.abs(part.amountCents))}`)
		.join(', ');
}

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
		/** See `PageData['upcomingBills']['emptyState']`. Only 'all-stale' widens `showDashboardBody`
		 *  on its own; left `null` by default like the ordinary populated case. */
		upcomingBillsEmptyState?: PageData['upcomingBills']['emptyState'];
		cashFlowForecast?: PageData['cashFlowForecast'];
	} = {}
): PageData {
	const {
		transactions = [],
		budgets = [],
		savingsGoals = [],
		upcomingBillsHasStreams = false,
		upcomingBillsEmptyState = null,
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
		recentTransactions: transactions
			.slice(0, 10)
			.map((transaction) => ({ ...transaction, splitIndicator: null })),
		insights: EMPTY_INSIGHTS,
		savingsGoals,
		savingsGoalsOverflowCount: 0,
		cashFlowForecast,
		upcomingBills: {
			rows: [],
			overdueCount: 0,
			remainingExpenseCents: 0,
			hasStreams: upcomingBillsHasStreams,
			emptyState: upcomingBillsEmptyState,
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

	/**
	 * Task 2026-08-02, follow-up to #97: `hasStreams` now excludes stale streams (so the widget can
	 * tell "no flow ever detected" apart from "en veille"), which on its own would have narrowed
	 * this gate for a user whose only detected stream went stale — reopening the exact regression
	 * the comment above this gate documents. `emptyState === 'all-stale'` restores the original
	 * "any stream ever detected, live or stale" reach.
	 */
	it('still widens the body for a period with no activity when the only detected stream is stale', async () => {
		expect.assertions(2);
		const screen = render(Page, {
			data: buildData({ upcomingBillsHasStreams: false, upcomingBillsEmptyState: 'all-stale' }),
			form: null as ActionData
		});

		await expect.element(screen.getByText(m.dashboard_upcoming_title())).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain(m.dashboard_empty_heading());
	});

	/**
	 * Fix round 1, IMPORTANT #1: the widget's own all-stale copy is deliberately distinct from the
	 * forecast card's (`m.dashboard_forecast_stale_title()`), because a user whose only stream is a
	 * cancelled but reliable-confirmed subscription reaches `emptyState: 'all-stale'` on BOTH
	 * surfaces at once, and the two cards are adjacent siblings on this same page — reusing one
	 * title would stack two empty cards reading the same thing. Pinned here rather than left to two
	 * separate specs staying accidentally in sync, since neither surface's own test can see the
	 * other's copy.
	 */
	it('renders two distinct all-stale empty cards, never the same title twice', async () => {
		expect.assertions(3);
		const screen = render(Page, {
			data: buildData({
				upcomingBillsHasStreams: false,
				upcomingBillsEmptyState: 'all-stale',
				cashFlowForecast: { ...EMPTY_FORECAST, emptyState: 'all-stale' }
			}),
			form: null as ActionData
		});

		await expect.element(screen.getByText(m.dashboard_upcoming_stale_title())).toBeInTheDocument();
		await expect.element(screen.getByText(m.dashboard_forecast_stale_title())).toBeInTheDocument();
		expect(m.dashboard_upcoming_stale_title()).not.toBe(m.dashboard_forecast_stale_title());
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
describe('/ dashboard recent transactions — split indicator (PR6)', () => {
	it("shows an INTERACTIVE répartition badge without moving the row's parent category/amount", async () => {
		expect.assertions(3);

		const data = buildData({
			transactions: [
				{
					id: 'carrefour',
					date: '2026-07-05',
					label: 'Carrefour Market',
					amountCents: -8_000,
					type: 'expense',
					category: 'Alimentation',
					source: 'csv'
				}
			]
		});
		data.recentTransactions = [
			{
				...data.recentTransactions[0],
				splitIndicator: {
					dominantCategory: 'Alimentation',
					dominantNature: 'spending',
					otherCategoryCount: 1,
					partCount: 2,
					parts: [
						{ category: 'Maison', amountCents: -2_000 },
						{ category: 'Alimentation', amountCents: -6_000 }
					]
				}
			}
		];

		const screen = render(Page, { data, form: null as ActionData });

		// The row still shows the PARENT's own category and amount (OD-3) — the badge only flags
		// the répartition, it never re-ranks or relabels the row from its parts.
		await expect.element(screen.getByText(/Carrefour Market/)).toBeInTheDocument();
		expect(screen.container.textContent).toContain('80,00');
		// Interactive here: `cardBase` carries no `overflow-hidden`, unlike /reports' desktop table.
		expect(
			screen
				.getByRole('button', {
					name: m.splits_row_badge_others_detail({
						count: 2,
						detail: detailOf([
							{ category: 'Maison', amountCents: -2_000 },
							{ category: 'Alimentation', amountCents: -6_000 }
						])
					})
				})
				.elements()
		).toHaveLength(1);
	});
});

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
		// The chart only renders on the populated branch (emptyState === null) — its own caption,
		// carried both as the SVG's aria-label and the sr-only table's <caption>, must be absent here.
		expect(screen.container.textContent).not.toContain(m.forecast_chart_caption());
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
		expect(screen.container.textContent).not.toContain(m.forecast_chart_caption());
	});

	/**
	 * Fix round 1, IMPORTANT #1: the CTA (`dashboard_forecast_empty_cta`, linking to
	 * `/reports#annexe-recurrences`) is not a remedy — it's "here is what was detected" — so both
	 * empty branches keep it. It is NOT proven to have anything to scroll to on /reports: that
	 * page's annexe table is `report.recurringPayments`, built from the selected period's expenses
	 * only, unrelated to the 12-month detector `emptyState` is computed from — see the CTA's own
	 * comment in `/+page.svelte` for the full reasoning and the dead-anchor case this does not fix.
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
