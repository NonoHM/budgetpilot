import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import './layout.css';
import * as m from '$lib/paraglide/messages';
import { formatCents } from '$lib/domain/budget';
import { formatShortDate } from '$lib/domain/dateFormat';
import { getLocale } from '$lib/paraglide/runtime';
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

/** A genuinely empty account: no transaction has ever existed, so the onboarding copy is true. */
const EMPTY_ACCOUNT_SPAN: PageData['accountSpan'] = {
	count: 0,
	firstDate: null,
	lastDate: null
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
		/** Account-level, period-independent (see `readAccountTransactionSpan`). Defaults to the
		 *  EMPTY account, so every test written before this field existed keeps asserting exactly the
		 *  state it always asserted: the first-run onboarding copy. */
		accountSpan?: PageData['accountSpan'];
	} = {}
): PageData {
	const {
		transactions = [],
		budgets = [],
		savingsGoals = [],
		upcomingBillsHasStreams = false,
		upcomingBillsEmptyState = null,
		cashFlowForecast = EMPTY_FORECAST,
		accountSpan = EMPTY_ACCOUNT_SPAN
	} = overrides;

	return {
		user: { email: 'user@example.com', role: 'USER' } as PageData['user'],
		categoryOptions: [],
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
		},
		accountSpan
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
 * Wave 2, finding A7. Every flag feeding `showDashboardBody` is period-scoped or lookback-scoped,
 * so before `accountSpan` the page could not tell "this account has never had data" from "this
 * account has data, just not in the period you are looking at" — and rendered the first-run
 * onboarding copy over both. A tester with 56 transactions freshly imported read it and concluded
 * the import had failed.
 *
 * The three states below are the whole fix. The first-run state is asserted UNCHANGED on purpose:
 * the new condition narrows the onboarding branch rather than replacing it, so a red here means
 * the branch went the wrong way round.
 */
describe('/ dashboard — empty state keys on the ACCOUNT, not the period (A7)', () => {
	const SPAN_SAME_YEAR: PageData['accountSpan'] = {
		count: 56,
		firstDate: '2026-03-03',
		lastDate: '2026-04-27'
	};

	it('shows the period-mismatch state, not the first-run copy, when the account has data elsewhere', async () => {
		expect.assertions(2);
		const screen = render(Page, {
			data: buildData({ accountSpan: SPAN_SAME_YEAR }),
			form: null as ActionData
		});

		await expect.element(screen.getByText(m.dashboard_other_period_heading())).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain(m.dashboard_empty_heading());
	});

	it('leaves the first-run copy exactly as it was on an account that has never had data', async () => {
		expect.assertions(2);
		const screen = render(Page, { data: buildData(), form: null as ActionData });

		await expect.element(screen.getByText(m.dashboard_empty_heading())).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain(m.dashboard_other_period_heading());
	});

	it('shows neither empty state once the period itself has data', async () => {
		expect.assertions(2);
		const screen = render(Page, {
			data: buildData({
				accountSpan: SPAN_SAME_YEAR,
				transactions: [
					{
						id: 't1',
						date: '2026-07-15',
						label: 'Salaire',
						amountCents: 250_000,
						category: 'Revenus',
						source: 'manual'
					}
				]
			}),
			form: null as ActionData
		});

		expect(screen.container.textContent).not.toContain(m.dashboard_other_period_heading());
		expect(screen.container.textContent).not.toContain(m.dashboard_empty_heading());
	});

	/**
	 * The acceptance criterion this wave was given: a sentence saying "your data covers another
	 * period" without saying WHICH is the same silence one layer down. The oracle calls the
	 * production formatter rather than retyping "3 mars" — a hand-typed literal would assert this
	 * spec's idea of French date formatting, not the app's, and would rot the moment the year rule
	 * changed. The two sides still come from different places: the component renders whatever it
	 * pulled off `accountSpan`, and this side formats the fixture's known dates.
	 */
	it('names the real range rather than a placeholder', async () => {
		expect.assertions(3);
		const screen = render(Page, {
			data: buildData({ accountSpan: SPAN_SAME_YEAR }),
			form: null as ActionData
		});

		const locale = getLocale();
		const text = screen.container.textContent ?? '';
		expect(text).toContain(formatShortDate(SPAN_SAME_YEAR.firstDate!, locale));
		expect(text).toContain(formatShortDate(SPAN_SAME_YEAR.lastDate!, locale));
		// The raw ISO must never reach the screen — that is what "forgot to format" looks like.
		expect(text).not.toContain('2026-03-03');
	});

	/**
	 * The count is carried rather than dropped because the state exists to refute "the import
	 * failed", and 56 refutes that where a date range does not. Asserted as an absolute figure
	 * beside the emptiness assertions above, per CLAUDE.md.
	 */
	it('states how many transactions are on record', async () => {
		expect.assertions(1);
		const screen = render(Page, {
			data: buildData({ accountSpan: SPAN_SAME_YEAR }),
			form: null as ActionData
		});

		expect(screen.container.textContent).toContain('56');
	});

	it('uses the singular description for an account holding exactly one transaction', async () => {
		expect.assertions(2);
		const screen = render(Page, {
			data: buildData({
				accountSpan: { count: 1, firstDate: '2026-03-03', lastDate: '2026-03-03' }
			}),
			form: null as ActionData
		});

		const locale = getLocale();
		const args = {
			count: 1,
			from: formatShortDate('2026-03-03', locale),
			to: formatShortDate('2026-03-03', locale)
		};
		await expect
			.element(screen.getByText(m.dashboard_other_period_description_one(args)))
			.toBeInTheDocument();
		// And the plural form is genuinely absent, not merely also present.
		expect(screen.container.textContent).not.toContain(
			m.dashboard_other_period_description_many(args)
		);
	});

	/**
	 * A span crossing a year boundary must name at least one year, or "du 3 déc. au 12 janv." is
	 * ambiguous and arguably false. `formatShortDate` decides the year per date against the CURRENT
	 * year, which makes the ambiguous form unreachable: two dates that both omit the year are both
	 * in the current year and cannot span a boundary. Asserted with a bare four-digit-year regex
	 * rather than by calling the formatter again, so this stays a real cross-check on the rendered
	 * sentence instead of an identity.
	 */
	it('names a year when the span crosses a year boundary', async () => {
		expect.assertions(2);
		const screen = render(Page, {
			data: buildData({
				accountSpan: { count: 120, firstDate: '2025-12-03', lastDate: '2026-01-12' }
			}),
			form: null as ActionData
		});

		// Scoped to the description paragraph, never the whole container: the period selector and
		// the page heading both print "2026" on their own, so a container-wide regex would pass
		// whatever the description said. Calibrated by breaking it — see the boundary probe.
		const description = Array.from(screen.container.querySelectorAll('p'))
			.map((paragraph) => paragraph.textContent ?? '')
			.find((text) => text.includes('120'));
		expect(description).toBeDefined();
		expect(description).toMatch(/\b20\d{2}\b/);
	});

	it('offers the way out and keeps an import entry point reachable', async () => {
		expect.assertions(2);
		const screen = render(Page, {
			data: buildData({ accountSpan: SPAN_SAME_YEAR }),
			form: null as ActionData
		});

		// `all-time` is an existing `parseDateRange` key and an existing option in the period
		// selector above — the way out is the period the user could already have picked by hand.
		expect(screen.container.querySelector('a[href="/?period=all-time"]')).not.toBeNull();
		expect(screen.container.querySelector('a[href="/import"]')).not.toBeNull();
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
	 * #202, and this REPLACES a pair of tests that pinned the opposite.
	 *
	 * Both empty branches used to offer `/reports#annexe-recurrences`, and that anchor is
	 * frequently absent: /reports renders it behind `{#if report.recurringPayments.length > 0}`,
	 * and that list is the SELECTED PERIOD's expenses with a ">= 2 occurrences" gate — unrelated to
	 * the 12-month detector `emptyState` comes from. In `all-stale` the two are close to
	 * anti-correlated: a stale stream is by definition silent longer than one cycle, so it cannot
	 * reach the annexe's own gate. An empty state exists to say what to do when there is nothing to
	 * show; it offered exactly one action and that action did nothing.
	 *
	 * Giving the anchor a stable target was considered and REFUSED: the link would then resolve and
	 * land on an empty section, which moves a dead end rather than removing one. The copy stands on
	 * its own instead — the `none-detected` description already names the condition to reach, and
	 * the `all-stale` one now says the projection returns by itself.
	 */
	it("offers no dead anchor in the 'none-detected' branch", async () => {
		const screen = render(Page, {
			data: buildData({
				upcomingBillsHasStreams: true,
				cashFlowForecast: { ...EMPTY_FORECAST, emptyState: 'none-detected' }
			}),
			form: null as ActionData
		});

		expect(screen.container.querySelector('a[href="/reports#annexe-recurrences"]')).toBeNull();
		// The control beside the emptiness assertion: the empty state itself must still be there,
		// or deleting the whole branch would pass the line above.
		expect(screen.container.textContent).toContain(m.dashboard_forecast_empty_title());
	});

	it("offers no dead anchor in the 'all-stale' branch either", async () => {
		const screen = render(Page, {
			data: buildData({
				upcomingBillsHasStreams: true,
				cashFlowForecast: { ...EMPTY_FORECAST, emptyState: 'all-stale' }
			}),
			form: null as ActionData
		});

		expect(screen.container.querySelector('a[href="/reports#annexe-recurrences"]')).toBeNull();
		expect(screen.container.textContent).toContain(m.dashboard_forecast_stale_title());
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
							id: 'tx-netflix',
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

/**
 * The manual-add modal is the app's only hand-entry path and the first thing a new user touches.
 * Its category field used to install an unreportable native `required` constraint that aborted the
 * submit with nothing on screen (see `Combobox.svelte.spec.ts`); the refusal now comes from the
 * server, which is the only side that is authoritative about it.
 *
 * A refusal a screen-reader user cannot perceive is the same defect one layer up, so the message
 * has to be announced rather than merely rendered. `AlertBanner variant="error"` is the app's own
 * component for exactly this and carries `aria-live="assertive"`; the hand-rolled
 * `<p class="text-sm font-medium text-rose-700">` it replaces carried nothing.
 */
describe('/ manual-add modal — a refused save says why, audibly (#audit-1.0)', () => {
	it('announces the server refusal instead of only colouring it red', async () => {
		expect.assertions(2);

		render(Page, {
			data: buildData({ upcomingBillsHasStreams: true }),
			form: { createTransactionError: 'Choisissez une catégorie.' } as ActionData
		});

		await userEvent.click(page.getByRole('button', { name: m.dashboard_manual_entry() }).first());

		const message = page.getByText('Choisissez une catégorie.').first();
		await expect.element(message).toBeInTheDocument();

		// The live region is the assertion, not the colour: assertive, because a refused save is not
		// something to mention at the next convenient pause.
		const liveRegion = message.element().closest('[aria-live]');
		expect(liveRegion?.getAttribute('aria-live')).toBe('assertive');
	});
});
