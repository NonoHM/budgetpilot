import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import type { MonthlyReport } from '$lib/server/reports/monthly';
import * as m from '$lib/paraglide/messages';
import { formatCents } from '$lib/domain/budget';
import Page from './+page.svelte';
import type { PageData } from './$types';

/** Same rule SplitBadge's own `detail` uses, called rather than retyped — `formatCents` puts a
 *  narrow no-break space before "€", which a hand-typed literal gets silently wrong. */
function detailOf(parts: { category: string; amountCents: number }[]): string {
	return parts
		.map((part) => `${part.category} ${formatCents(Math.abs(part.amountCents))}`)
		.join(', ');
}

/**
 * Task 2 of the detection-window-upper-bound chantier: `emptyState` distinguishes "nothing
 * detected yet" from "detected streams have all gone stale", so the forecast panel must render a
 * different EmptyState for each rather than collapsing both into one sentence. Asserted against
 * the Paraglide message, never a hardcoded French literal (CLAUDE.md).
 */

const PERIOD: PageData['period'] = {
	key: 'this-month',
	label: 'juillet 2026',
	from: new Date('2026-07-01T00:00:00.000Z'),
	to: new Date('2026-08-01T00:00:00.000Z'),
	fromDate: '2026-07-01',
	toDate: '2026-08-01',
	budgetMonth: '2026-07'
};

// Hand-built rather than via `buildPeriodReport` — that helper lives in `$lib/server/reports/monthly`,
// which transitively pulls in Prisma and cannot be imported from a browser-environment component spec.
// `transactionCount: 1` is the only field the forecast section's own gate (`hasData`) reads.
function buildReport(): MonthlyReport {
	return {
		month: PERIOD.label,
		incomeCents: 0,
		expenseCents: 0,
		balanceCents: 0,
		transactionCount: 1,
		expenseAveragePerDayCents: 0,
		savingsRate: null,
		topCategories: [],
		largestExpenses: [],
		recurringPayments: [],
		natureAnalysis: {
			incomeCents: 0,
			spendingCents: 0,
			investmentCents: 0,
			transferCents: 0,
			refundCents: 0,
			feeCents: 0,
			uncategorizedCents: 0
		},
		takeaways: []
	};
}

function buildData(emptyState: PageData['cashFlowForecast']['emptyState']): PageData {
	return {
		user: { email: 'user@example.com', role: 'USER' },
		month: PERIOD.budgetMonth,
		period: PERIOD,
		periodQuery: 'period=this-month',
		report: buildReport(),
		categories: [],
		cashFlowForecast: {
			hasBalanceAnchor: false,
			days: [],
			todayIndex: 0,
			flows: [],
			emptyState
		},
		forecastHorizonMonths: 3
	} as PageData;
}

describe('/reports largest expenses — split indicator (PR6)', () => {
	it('shows an INERT répartition badge on a split expense, and none on an unsplit one', async () => {
		expect.assertions(3);

		const data = buildData('none-detected');
		data.report = {
			...buildReport(),
			transactionCount: 2,
			largestExpenses: [
				{
					label: 'Loyer - Logement',
					amountCents: 80_000,
					category: 'Logement',
					splitIndicator: {
						dominantCategory: 'Logement',
						dominantNature: 'spending',
						otherCategoryCount: 1,
						partCount: 2,
						parts: [
							{ category: 'Assurance', amountCents: -20_000 },
							{ category: 'Logement', amountCents: -60_000 }
						]
					}
				},
				{
					label: 'Courses - Alimentation',
					amountCents: 4_000,
					category: 'Alimentation',
					splitIndicator: null
				}
			]
		};

		const screen = render(Page, { data });

		// Never `interactive` on this surface: the desktop card wraps the table in
		// `overflow-hidden` on both axes, which would clip the hover bubble (see +page.svelte). Named
		// by the exact aria-label the interactive branch would set, rather than by role — the period
		// forms carry their own submit buttons.
		const interactiveName = m.splits_row_badge_others_detail({
			count: 2,
			detail: detailOf([
				{ category: 'Assurance', amountCents: -20_000 },
				{ category: 'Logement', amountCents: -60_000 }
			])
		});
		expect(document.querySelector(`[aria-label="${interactiveName}"]`)).toBeNull();

		await expect
			.element(screen.getByText(m.splits_row_badge_others_short({ count: 2 })).first())
			.toBeInTheDocument();
		// The desktop table and the mobile card both render in the DOM at once (CSS, not `{#if}`,
		// picks the visible one — same shape CLAUDE.md records for the flows/upcoming-bills tables),
		// so the split row's sentence legitimately appears twice, and the unsplit row's never does.
		expect(screen.getByText(m.splits_row_badge_others_short({ count: 2 })).elements()).toHaveLength(
			2
		);
	});
});

describe('/reports forecast panel — split empty-state copy (Task 2)', () => {
	it("renders the 'nothing detected yet' copy when emptyState is 'none-detected'", async () => {
		expect.assertions(3);

		const screen = render(Page, { data: buildData('none-detected') });

		await expect.element(screen.getByText(m.reports_forecast_empty_title())).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain(m.reports_forecast_stale_title());
		// The chart only renders on the populated branch (emptyState === null) — its own caption,
		// carried both as the SVG's aria-label and the sr-only table's <caption>, must be absent here.
		expect(screen.container.textContent).not.toContain(m.forecast_chart_caption());
	});

	it("renders the 'gone stale' copy when emptyState is 'all-stale'", async () => {
		expect.assertions(3);

		const screen = render(Page, { data: buildData('all-stale') });

		await expect.element(screen.getByText(m.reports_forecast_stale_title())).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain(m.reports_forecast_empty_title());
		expect(screen.container.textContent).not.toContain(m.forecast_chart_caption());
	});

	/**
	 * Fix round 1, IMPORTANT #1: the CTA (`reports_forecast_empty_cta`, linking to
	 * `#annexe-recurrences`) is not a remedy — it's "here is what was detected" — so both empty
	 * branches keep it. It is NOT proven to have anything to scroll to: the annexe table is
	 * `report.recurringPayments`, built from the selected period's expenses only, unrelated to the
	 * 12-month detector `emptyState` is computed from — see the CTA's own comment in `+page.svelte`
	 * for the full reasoning and the dead-anchor case this does not fix.
	 */
	it("renders the annexe-recurrences CTA in the 'none-detected' branch", async () => {
		expect.assertions(2);

		const screen = render(Page, { data: buildData('none-detected') });

		const cta = screen.container.querySelector('a[href="#annexe-recurrences"]');
		expect(cta).not.toBeNull();
		expect(cta?.textContent).toBe(m.reports_forecast_empty_cta());
	});

	it("renders the same annexe-recurrences CTA in the 'all-stale' branch", async () => {
		expect.assertions(2);

		const screen = render(Page, { data: buildData('all-stale') });

		const cta = screen.container.querySelector('a[href="#annexe-recurrences"]');
		expect(cta).not.toBeNull();
		expect(cta?.textContent).toBe(m.reports_forecast_empty_cta());
	});

	/**
	 * Fix round 1, IMPORTANT #2: the populated branch now gates on `cashFlowForecast.emptyState
	 * === null`, the total discriminator, rather than a separately re-derived
	 * `flows.some(f => f.feedsProjection)` boolean that could silently diverge from it. This is the
	 * render path that coupling used to guard and is otherwise unexercised by the two tests above.
	 */
	it('renders the populated forecast (chart + flows table), not an empty state, when emptyState is null', async () => {
		expect.assertions(4);

		const data = buildData(null);
		data.cashFlowForecast.flows = [
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
		];

		const screen = render(Page, { data });

		// A desktop and a mobile copy of the flows table render simultaneously (CSS hides one per
		// breakpoint, not the DOM). Asserting a length of 2 — not `.first()` — so a regression that
		// stops one copy from rendering (e.g. a breakpoint class typo) fails this test instead of
		// staying green on the surviving copy: the "filtered to the expected set before comparing"
		// shape this project has been bitten by before.
		await expect
			.element(screen.getByText(m.reports_forecast_flows_title()).first())
			.toBeInTheDocument();
		expect(screen.getByText(m.reports_forecast_flows_title()).elements()).toHaveLength(2);
		expect(screen.container.textContent).not.toContain(m.reports_forecast_empty_title());
		expect(screen.container.textContent).not.toContain(m.reports_forecast_stale_title());
	});
});
