import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import './layout.css';
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
	flows: []
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
	} = {}
): PageData {
	const {
		transactions = [],
		budgets = [],
		savingsGoals = [],
		upcomingBillsHasStreams = false
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
		cashFlowForecast: EMPTY_FORECAST,
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
