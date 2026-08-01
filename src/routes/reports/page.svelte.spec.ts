import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import type { MonthlyReport } from '$lib/server/reports/monthly';
import * as m from '$lib/paraglide/messages';
import Page from './+page.svelte';
import type { PageData } from './$types';

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

describe('/reports forecast panel — split empty-state copy (Task 2)', () => {
	it("renders the 'nothing detected yet' copy when emptyState is 'none-detected'", async () => {
		const screen = render(Page, { data: buildData('none-detected') });

		await expect.element(screen.getByText(m.reports_forecast_empty_title())).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain(m.reports_forecast_stale_title());
	});

	it("renders the 'gone stale' copy when emptyState is 'all-stale'", async () => {
		const screen = render(Page, { data: buildData('all-stale') });

		await expect.element(screen.getByText(m.reports_forecast_stale_title())).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain(m.reports_forecast_empty_title());
	});

	/**
	 * Fix round 1, IMPORTANT #1: the CTA (`reports_forecast_empty_cta`, linking to
	 * `#annexe-recurrences`) is not a remedy — it's "here is what was detected" — so both empty
	 * branches keep it. `all-stale` in particular means at least one flow WAS reliable-confirmed,
	 * so the annexe table it links to certainly has rows.
	 */
	it("renders the annexe-recurrences CTA in the 'none-detected' branch", async () => {
		const screen = render(Page, { data: buildData('none-detected') });

		const cta = screen.container.querySelector('a[href="#annexe-recurrences"]');
		expect(cta).not.toBeNull();
		expect(cta?.textContent).toBe(m.reports_forecast_empty_cta());
	});

	it("renders the same annexe-recurrences CTA in the 'all-stale' branch", async () => {
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

		// Both a desktop and a mobile copy of the flows table render simultaneously (CSS hides one
		// per breakpoint) — `.first()` avoids the strict-mode duplicate-match failure that would
		// otherwise come from the layout, not from this test's own logic.
		await expect
			.element(screen.getByText(m.reports_forecast_flows_title()).first())
			.toBeInTheDocument();
		expect(screen.container.textContent).not.toContain(m.reports_forecast_empty_title());
		expect(screen.container.textContent).not.toContain(m.reports_forecast_stale_title());
	});
});
