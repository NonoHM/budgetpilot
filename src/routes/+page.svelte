<script lang="ts">
	import { formatCents } from '$lib/domain/budget';
	import { labelledValue } from '$lib/domain/typography';
	import { getTransactionKind } from '$lib/domain/transaction';
	import type { TransactionNature } from '$lib/domain/transaction';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating } from '$app/state';
	import { enhance } from '$app/forms';
	import Modal from '$lib/components/Modal.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import Button from '$lib/components/Button.svelte';
	import DashboardInsights from '$lib/components/DashboardInsights.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import SplitBadge from '$lib/components/splits/SplitBadge.svelte';
	import PeriodFilter from '$lib/components/ui/PeriodFilter.svelte';
	import { REPORTING_PERIOD_PRESET_IDS, periodQueryOfRange } from '$lib/domain/periodPresets';
	import { getInitials } from '$lib/domain/initials';
	import { cardBase, inputBase } from '$lib/styles';
	import Combobox from '$lib/components/ui/Combobox.svelte';
	import BudgetStatusCard from '$lib/components/ui/BudgetStatusCard.svelte';
	import GoalStatusCard from '$lib/components/ui/GoalStatusCard.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import MoneyInput from '$lib/components/ui/MoneyInput.svelte';
	import DashboardSkeleton from '$lib/components/DashboardSkeleton.svelte';
	import CashFlowForecastChart from '$lib/components/ui/CashFlowForecastChart.svelte';
	import UpcomingBillsCard from '$lib/components/UpcomingBillsCard.svelte';
	import { categoryDisplayName } from '$lib/domain/categoryLabels';
	import { formatShortDate } from '$lib/domain/dateFormat';
	import { getNatureTag } from '$lib/domain/natureLabels';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const summary = $derived(data.summary);
	const recentTransactions = $derived(data.recentTransactions);
	// Savings goals are declarative/linked-account data, independent of transactions or budgets
	// (see CLAUDE.md's "Savings goals" note) — a user who only set up goals and net-worth
	// accounts, with no transaction imported yet, must still see their goals widget instead of
	// the generic "import your first statement" empty state.
	const hasDashboardData = $derived(
		data.transactions.length > 0 || data.budgets.length > 0 || data.savingsGoals.length > 0
	);
	// `hasDashboardData` keys on the CURRENT PERIOD's transactions, so a user with detected
	// recurring streams but no activity this period would otherwise land in the onboarding empty
	// state below and never see the upcoming-bills widget — precisely when it matters most
	// (Task 3, B5a). `hasStreams` is period-independent (computed over the detector's own 12-month
	// window, see service.ts), so it widens the "state with data" branch on its own. The header's
	// Import / Saisie manuelle buttons are gated on this same flag rather than on
	// `hasDashboardData`: they are the only import entry point left once the onboarding EmptyState
	// stops rendering, so keying them on the narrower flag stranded that state with no CTA at all.
	//
	// `hasStreams` narrowed to LIVE streams only since task 2026-08-02 (follow-up to #97, so
	// `UpcomingBillsCard` can tell "no flow ever detected" from "en veille" apart) — so a user whose
	// only detected stream has gone stale would otherwise lose this widening and see the onboarding
	// screen despite having real historical data on file. `emptyState === 'all-stale'` restores the
	// original "any stream ever detected, live or stale" reach on its own.
	const showDashboardBody = $derived(
		hasDashboardData ||
			data.upcomingBills.hasStreams ||
			data.upcomingBills.emptyState === 'all-stale'
	);
	// Every flag above is period-scoped or lookback-scoped, so none of them can tell "this account
	// has never had data" from "this account has data, just not in the period you are looking at".
	// Rendering the first-run copy over the second case is what made a user who had just imported 56
	// transactions conclude the import had failed (blind session, finding A7). `accountSpan` is the
	// only account-level fact on this payload, and it narrows the onboarding branch rather than
	// replacing it: on a genuinely empty account `count` is 0 and the copy below is untouched.
	const hasAccountHistory = $derived(data.accountSpan.count > 0);
	// `formatShortDate` decides the year PER DATE against the current year, which is what keeps this
	// unambiguous across a year boundary at no extra cost: two dates that both omit the year are
	// both in the current year and therefore cannot span one. Measured across six boundary cases,
	// including "du 3 déc. 2025 au 12 janv." and "du 1 mars 2024 au 27 avr." — asymmetric, and the
	// asymmetry is exactly what carries the information. Kept rather than forcing the year on both
	// sides, which would only add noise to the common single-year case.
	const accountSpanDescription = $derived.by(() => {
		const { count, firstDate, lastDate } = data.accountSpan;
		if (!firstDate || !lastDate) return '';
		const locale = getLocale();
		const args = {
			count,
			from: formatShortDate(firstDate, locale),
			to: formatShortDate(lastDate, locale)
		};
		return count !== 1
			? m.dashboard_other_period_description_many(args)
			: m.dashboard_other_period_description_one(args);
	});
	// Delta = projected balance at the end of the horizon minus today's known balance (the ledger's
	// realized/projected boundary, see CashFlowLedger.todayIndex) — colored per the app's standard
	// monetary convention (emerald positive / rose negative), unlike the chart's own monochrome
	// trace (see CLAUDE.md's forecast palette decision).
	const forecastToday = $derived(data.cashFlowForecast.days[data.cashFlowForecast.todayIndex]);
	const forecastEnd = $derived(data.cashFlowForecast.days[data.cashFlowForecast.days.length - 1]);
	const forecastDeltaCents = $derived(
		(forecastEnd?.balanceCents ?? 0) - (forecastToday?.balanceCents ?? 0)
	);
	const forecastDeltaFormatted = $derived(
		`${forecastDeltaCents >= 0 ? '+' : ''}${formatCents(forecastDeltaCents)}`
	);
	const forecastEndDateFormatted = $derived(
		forecastEnd ? formatShortDate(forecastEnd.date, getLocale()) : ''
	);
	const period = $derived(data.period);
	// Perceptible-delay site: the dashboard's own `load()` re-runs on every period-selector
	// change (client-side `goto('?period=...')`), same technique as /transactions' Skeleton.
	const isNavigatingDashboard = $derived(navigating.to?.url.pathname === '/');
	const natureAnalysis = $derived(data.natureAnalysis);
	const budgetSummaries = $derived(data.summary.categorySummaries.slice(0, 6));

	/**
	 * Recent transactions keep the parent's own category (never re-ranked or relabelled from a
	 * répartition's parts, same OD-3 posture as `/reports`' largest expenses) and only gain the
	 * badge. Interactive: this card carries no `overflow-hidden` ancestor (`cardBase` has none), so
	 * the hover bubble is never clipped — unlike `/reports`' desktop table.
	 */
	function badgeParts(
		indicator: NonNullable<(typeof recentTransactions)[number]['splitIndicator']>
	): Array<{ category: string; amountCents: number }> {
		return indicator.parts.map((part) => ({
			category: categoryDisplayName(part.category),
			amountCents: part.amountCents
		}));
	}

	// Number of natures with a non-zero amount — shown in the "Real analysis" badge
	const activeNatureCount = $derived(
		[
			natureAnalysis.spendingCents,
			natureAnalysis.investmentCents,
			natureAnalysis.transferCents,
			natureAnalysis.refundCents,
			natureAnalysis.feeCents,
			natureAnalysis.uncategorizedCents
		].filter((c) => c !== 0).length
	);

	let showManualModal = $state(false);
	let manualTransactionCategory = $state('');
	let createTransactionSubmitting = $state(false);
	let analysisOpen = $state(false);
	$effect(() => {
		if (form?.createTransactionSuccess) showManualModal = false;
	});

	$effect(() => {
		if (!showManualModal) manualTransactionCategory = '';
	});

	/**
	 * Applying a range from the Periode panel.
	 *
	 * `periodQueryOfRange` rather than always writing `period=custom&from=...&to=...`: a range that
	 * IS one of this screen's named periods has to be serialised under that name, because
	 * `server/date-range.ts` derives `comparisonMonth` from the KEY and only for `this-month` and
	 * `last-month`. Flattening every preset to a custom range would take the month-over-month
	 * comparison off this page with nothing saying so. /reports uses the same function, and
	 * `date-range.spec.ts` pins it against the server's own serialiser.
	 */
	function applyPeriod(range: { from: string; to: string }) {
		const query = periodQueryOfRange(range, data.todayIso, REPORTING_PERIOD_PRESET_IDS);
		goto(resolve(`/?${query}` as `/?${string}`));
	}

	/** Clearing goes back to the default period, which is what a dashboard with no `?period=` shows. */
	function resetPeriod() {
		goto(resolve('/'));
	}

	function isNeutralNature(nature: TransactionNature | undefined): boolean {
		return nature === 'transfer' || nature === 'investment';
	}

	function formatDateShort(dateStr: string): string {
		const d = new Date(`${dateStr}T00:00:00.000Z`);
		const monthName = new Intl.DateTimeFormat(getLocale(), {
			month: 'short',
			timeZone: 'UTC'
		}).format(d);
		return `${d.getUTCDate()} ${monthName}`;
	}

	function getTodayDate(): string {
		return new Date().toISOString().slice(0, 10);
	}
</script>

<svelte:head>
	<title>BudgetPilot</title>
	<meta name="description" content={m.dashboard_meta_description()} />
</svelte:head>

<main class="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
	<!-- Header + period selector -->
	<div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
		<div>
			<h1 class="text-xl font-semibold tracking-tight">{m.nav_dashboard()}</h1>
			<p class="mt-1 text-sm text-zinc-500">
				{#if hasDashboardData}
					{data.transactions.length !== 1
						? m.dashboard_transaction_count_many({
								period: period.label,
								count: data.transactions.length
							})
						: m.dashboard_transaction_count_one({
								period: period.label,
								count: data.transactions.length
							})}
				{:else}
					{period.label}
				{/if}
			</p>
		</div>

		<div class="flex flex-col gap-3 lg:shrink-0 lg:items-end lg:gap-2">
			<div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-2">
				<!-- #547. The same Periode panel /transactions mounts, with this screen's own preset
				     set passed as a prop. Before this it was a Select plus a revealed row of two text
				     date boxes: the boxes worked, but there was no calendar anywhere, and the option
				     list was written out here and twice more in reports/+page.svelte.

				     Two mounts rather than one responsive mount, mirroring /transactions: `surface`
				     decides the trigger height (46px on touch, 34px on desktop) and one mount cannot
				     be both, so a single desktop mount would put a 34px target on a phone. -->
				<div class="w-full lg:hidden">
					<PeriodFilter
						dimensionLabel={m.reports_period_label()}
						from={period.fromDate}
						to={period.toDate}
						invalid={false}
						locale={getLocale()}
						todayIso={data.todayIso}
						presets={REPORTING_PERIOD_PRESET_IDS}
						allowCustomRung={false}
						surface="mobile"
						backLabel={m.common_close()}
						clearAriaLabel={m.reports_period_reset_aria()}
						onApply={applyPeriod}
						onClear={resetPeriod}
					/>
				</div>
				<div class="hidden lg:block lg:w-auto">
					<PeriodFilter
						dimensionLabel={m.reports_period_label()}
						from={period.fromDate}
						to={period.toDate}
						invalid={false}
						locale={getLocale()}
						todayIso={data.todayIso}
						presets={REPORTING_PERIOD_PRESET_IDS}
						triggerSize="field"
						allowCustomRung={true}
						clearAriaLabel={m.reports_period_reset_aria()}
						onApply={applyPeriod}
						onClear={resetPeriod}
					/>
				</div>

				<!-- Same gate as the body, not `hasDashboardData`: the onboarding EmptyState below is the
				     only other "/import" call to action on this page, and it renders only when the body
				     does not. Keyed on `hasDashboardData` alone, a user with detected streams but no
				     activity this period got the body, no empty state, and no way to import from the
				     dashboard at all (the top nav goes to /imports, the history page). -->
				{#if showDashboardBody}
					<div class="flex gap-2 lg:contents">
						<Button
							variant="secondary"
							size="field"
							class="flex flex-1 items-center justify-center !border-zinc-200 lg:flex-none lg:!border-zinc-300"
							onclick={() => (showManualModal = true)}
						>
							{m.dashboard_manual_entry()}
						</Button>
						<Button
							href="/import"
							size="field"
							class="flex flex-1 items-center justify-center lg:flex-none"
						>
							{m.dashboard_import()}
						</Button>
					</div>
				{/if}
			</div>
		</div>
	</div>

	{#if isNavigatingDashboard}
		<DashboardSkeleton />
	{:else}
		<!-- KPIs — toujours visibles -->
		<div class="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
			<div class="{cardBase} px-5 py-5 lg:py-4">
				<div class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
					{m.reports_kpi_income()}
				</div>
				<div class="mt-1.5 text-3xl font-bold text-emerald-600 lg:text-2xl lg:font-semibold">
					{formatCents(summary.incomeCents)}
				</div>
			</div>
			<div class="{cardBase} px-5 py-5 lg:py-4">
				<div class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
					{m.reports_kpi_expense()}
				</div>
				<div class="mt-1.5 text-3xl font-bold text-rose-600 lg:text-2xl lg:font-semibold">
					{formatCents(summary.expenseCents)}
				</div>
			</div>
			<div class="{cardBase} px-5 py-5 lg:py-4">
				<div class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
					{m.dashboard_kpi_balance_period()}
				</div>
				<div
					class="mt-1.5 text-3xl font-bold lg:text-2xl lg:font-semibold"
					class:text-emerald-600={summary.balanceCents > 0}
					class:text-rose-600={summary.balanceCents < 0}
					class:text-zinc-500={summary.balanceCents === 0}
				>
					{formatCents(summary.balanceCents)}
				</div>
			</div>
		</div>

		<DashboardInsights
			insights={data.insights}
			aiAdvice={data.aiAdvice}
			aiAllowed={data.aiAllowed}
		/>

		{#if !showDashboardBody}
			{#snippet emptyIcon()}
				<svg
					class="h-5 w-5 text-zinc-400"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M12 3v12" />
					<path d="m7 10 5 5 5-5" />
					<path d="M5 21h14" />
				</svg>
			{/snippet}
			{#if hasAccountHistory}
				<!-- The account HAS data, this period does not. Reached by landing on `/` (default
				     `this-month`) after importing a statement dated outside the current month. The
				     description names the real span rather than saying "another period" and stopping,
				     and it leads with the row count because the state exists to refute "the import
				     failed" — a count refutes that where a date range does not.
				     The action pair is EmptyState's documented `action` snippet, the same two-button
				     shape /reports already uses for its own import + change-period pair. The import
				     link stays reachable here for the reason the header gate above records: this panel
				     is the page's only other "/import" entry point while the body is hidden. -->
				{#snippet otherPeriodIcon()}
					<svg
						class="h-5 w-5 text-zinc-400"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<rect x="3" y="5" width="18" height="16" rx="2" />
						<path d="M3 10h18" />
						<path d="M8 3v4" />
						<path d="M16 3v4" />
					</svg>
				{/snippet}
				{#snippet otherPeriodAction()}
					<div class="mt-1 flex w-full flex-col items-center gap-2 sm:w-auto sm:flex-row">
						<Button href="/?period=all-time" class="w-full sm:w-auto">
							{m.dashboard_other_period_cta()}
						</Button>
						<Button href="/import" variant="secondary" class="w-full sm:w-auto">
							{m.dashboard_other_period_import_cta()}
						</Button>
					</div>
				{/snippet}
				<EmptyState
					class="mt-6"
					icon={otherPeriodIcon}
					title={m.dashboard_other_period_heading()}
					description={accountSpanDescription}
					action={otherPeriodAction}
				/>
			{:else}
				<EmptyState
					class="mt-6"
					icon={emptyIcon}
					title={m.dashboard_empty_heading()}
					description={m.dashboard_empty_description()}
					ctaLabel={m.dashboard_empty_cta()}
					ctaHref="/import"
					secondaryLabel={m.dashboard_empty_manual_cta()}
					onSecondaryClick={() => (showManualModal = true)}
				/>
				<p class="mt-3 text-center text-xs text-zinc-400">
					{m.dashboard_empty_footer()}
				</p>
			{/if}
		{:else}
			<!-- STATE WITH DATA -->
			<!-- Explicit two-column flex layout, wrapped — never CSS grid auto-placement (the root
		     cause of the historical Objectifs mispositioning bug). The side column naturally
		     wraps below the main column once it no longer fits (~900px, tablet zone), still
		     without any dedicated tablet-only styling. -->
			<div class="mt-6 flex flex-wrap items-start gap-6 lg:mt-8 lg:gap-8">
				<!-- Main column -->
				<div
					class="flex min-w-full flex-1 flex-col gap-6 lg:min-w-[480px] lg:basis-[560px] lg:gap-8"
				>
					<!-- Recent transactions -->
					<div class="{cardBase} p-5">
						<div class="flex items-baseline justify-between">
							<h2 class="text-sm font-semibold tracking-tight text-zinc-900">
								{m.dashboard_recent_transactions_heading()}
							</h2>
							<a
								class="text-sm font-medium text-zinc-500 hover:text-zinc-700"
								href={resolve('/transactions')}
							>
								{m.dashboard_view_all()}
							</a>
						</div>

						{#if recentTransactions.length > 0}
							<div class="mt-3 divide-y divide-zinc-100">
								{#each recentTransactions as tx, i (tx.id)}
									{@const kind = getTransactionKind(tx)}
									{@const neutral = isNeutralNature(tx.nature)}
									{@const tag = getNatureTag(tx.nature)}
									<div
										class="{i >= 5 ? 'hidden lg:flex' : 'flex'} items-center gap-4 py-3.5 lg:py-3"
									>
										<Avatar initials={getInitials(tx.label)} size={32} />
										<div class="min-w-0 flex-1">
											<div class="flex items-center gap-2">
												<span class="truncate text-sm font-medium text-zinc-900">{tx.label}</span>
												{#if tag}
													<span class="shrink-0">
														<Badge tone="neutral" bordered shape="rounded">{tag}</Badge>
													</span>
												{/if}
											</div>
											<!-- min-h-6 RESERVES the badge's own height on this line for every row, split or
											     not — a minimum, never a fixed height (see CLAUDE.md: a fixed one absorbs
											     an overflow invisibly, a minimum lets it grow and stay visible).
											     24px, NOT the 22 the two inert surfaces reserve, and the difference is the
											     whole point: this is the one surface here whose badge is INTERACTIVE, and
											     an interactive badge is a `h-6` button. Reserving 22 measured a real
											     +2px delta between a split row and a plain one — the reservation was
											     undersized by exactly the button's extra height, so the content pushed the
											     row, which is the thing a reservation exists to stop. The 2px is paid by
											     every row equally instead. -->
											<div class="flex min-h-6 min-w-0 items-center gap-1.5 text-xs text-zinc-400">
												<span class="min-w-0 truncate"
													>{formatDateShort(tx.date)} · {categoryDisplayName(tx.category)}</span
												>
												{#if tx.splitIndicator}
													<SplitBadge
														parts={badgeParts(tx.splitIndicator)}
														otherCategoryCount={tx.splitIndicator.otherCategoryCount}
														dominantCategory={categoryDisplayName(
															tx.splitIndicator.dominantCategory
														)}
														interactive
													/>
												{/if}
											</div>
										</div>
										<div
											class="shrink-0 text-sm font-semibold tabular-nums"
											class:text-rose-600={!neutral && kind === 'expense'}
											class:text-emerald-600={!neutral && kind === 'income'}
											class:text-zinc-500={neutral}
										>
											{kind === 'expense' ? '−' : '+'}{formatCents(Math.abs(tx.amountCents))}
										</div>
									</div>
								{/each}
							</div>
						{:else}
							<div class="mt-4">
								<p class="text-sm text-zinc-500">{m.dashboard_no_transactions_period()}</p>
								<a
									class="mt-2 inline-block text-sm font-medium text-zinc-500 hover:text-zinc-700"
									href={resolve('/transactions')}
								>
									{m.dashboard_view_all_transactions()}
								</a>
							</div>
						{/if}
					</div>

					<!-- Real analysis (collapsed by default) -->
					<div class={cardBase}>
						<button
							class="flex w-full items-center justify-between px-5 py-4 text-left lg:px-4 lg:py-3"
							onclick={() => (analysisOpen = !analysisOpen)}
							aria-expanded={analysisOpen}
						>
							<div class="flex items-center gap-2">
								<span class="text-sm font-semibold text-zinc-900"
									>{m.dashboard_analysis_heading()}</span
								>
								{#if activeNatureCount > 0}
									<Badge tone="neutral" shape="rounded">
										{activeNatureCount !== 1
											? m.dashboard_nature_count_many({ count: activeNatureCount })
											: m.dashboard_nature_count_one({ count: activeNatureCount })}
									</Badge>
								{/if}
							</div>
							<svg
								class="h-4 w-4 text-zinc-400 transition-transform duration-150"
								class:rotate-180={analysisOpen}
								viewBox="0 0 20 20"
								fill="none"
								aria-hidden="true"
							>
								<path
									d="M5.5 7.5 10 12l4.5-4.5"
									stroke="currentColor"
									stroke-width="1.5"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
						</button>

						{#if analysisOpen}
							<div class="grid gap-2.5 border-t border-zinc-100 px-5 py-5 text-sm lg:px-4 lg:py-4">
								<div class="flex items-center justify-between gap-3">
									<span class="text-zinc-600">{m.dashboard_nature_spending()}</span>
									<span class="font-semibold text-zinc-900 tabular-nums">
										{formatCents(natureAnalysis.spendingCents)}
									</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-zinc-600">{m.dashboard_nature_investment()}</span>
									<span class="font-semibold text-zinc-900 tabular-nums">
										{formatCents(natureAnalysis.investmentCents)}
									</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-zinc-600">{m.dashboard_nature_transfer()}</span>
									<span class="font-semibold text-zinc-900 tabular-nums">
										{formatCents(natureAnalysis.transferCents)}
									</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-zinc-600">{m.dashboard_nature_refund()}</span>
									<span class="font-semibold text-zinc-900 tabular-nums">
										{formatCents(natureAnalysis.refundCents)}
									</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-zinc-600">{m.dashboard_nature_fee()}</span>
									<span class="font-semibold text-zinc-900 tabular-nums">
										{formatCents(natureAnalysis.feeCents)}
									</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-zinc-600">{m.dashboard_nature_uncategorized()}</span>
									<span class="font-semibold text-zinc-900 tabular-nums">
										{formatCents(natureAnalysis.uncategorizedCents)}
									</span>
								</div>
							</div>
						{/if}
					</div>
				</div>

				<!-- Side column -->
				<div
					class="flex min-w-full flex-1 flex-col gap-6 lg:min-w-[300px] lg:basis-[320px] lg:gap-8"
				>
					<!-- Budget tracking -->
					<div class="{cardBase} p-5">
						<div class="flex items-baseline justify-between">
							<h2 class="text-sm font-semibold tracking-tight text-zinc-900">
								{m.reports_budget_tracking_title()}
							</h2>
							<a
								class="text-sm font-medium text-zinc-500 hover:text-zinc-700"
								href={resolve('/budgets')}
							>
								{m.dashboard_budget_manage()}
							</a>
						</div>

						{#if !data.budgetSummaryAvailable}
							<p class="mt-3 text-sm text-zinc-400">
								{m.dashboard_budget_unavailable()}
							</p>
						{:else if budgetSummaries.length > 0}
							<div class="mt-3 space-y-3">
								{#each budgetSummaries as cat (cat.category)}
									<BudgetStatusCard
										variant="plain"
										categoryLabel={categoryDisplayName(cat.category)}
										spentCents={cat.spentCents}
										limitCents={cat.limitCents}
									/>
								{/each}
							</div>
						{:else}
							<EmptyState
								class="mt-3"
								card={false}
								title={m.dashboard_no_budget()}
								ctaLabel={m.dashboard_create_budget_link()}
								ctaHref="/budgets"
							/>
						{/if}
					</div>

					<!-- Savings goals -->
					<div class="{cardBase} p-5">
						<div class="flex items-baseline justify-between">
							<h2 class="text-sm font-semibold tracking-tight text-zinc-900">
								{m.savings_goals_title()}
							</h2>
							{#if data.savingsGoals.length > 0 && data.savingsGoalsOverflowCount > 0}
								<TapLink href="/net-worth">{m.savings_goals_see_all()}</TapLink>
							{/if}
						</div>
						{#if data.savingsGoals.length > 0}
							<div class="mt-3 space-y-3">
								{#each data.savingsGoals as goal (goal.id)}
									<GoalStatusCard
										variant="plain"
										name={goal.name}
										currentAmountCents={goal.currentAmountCents}
										targetAmountCents={goal.targetAmountCents}
										progressPercent={goal.progressPercent}
										status={goal.status}
									/>
								{/each}
							</div>
						{:else}
							{#snippet goalsEmptyIcon()}
								<svg
									class="h-4 w-4 text-zinc-400"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="1.6"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<path d="M12 3v12" />
									<path d="m7 10 5 5 5-5" />
									<path d="M5 21h14" />
								</svg>
							{/snippet}
							<EmptyState
								class="mt-3"
								card={false}
								icon={goalsEmptyIcon}
								title={m.dashboard_goals_empty_title()}
								description={m.dashboard_goals_empty_description()}
								ctaLabel={m.dashboard_goals_empty_cta()}
								ctaHref="/net-worth"
							/>
						{/if}
					</div>

					<!-- Reachable here even when `hasDashboardData` is false — see `showDashboardBody`
					     above (Task 3, B5a). The card itself already renders a dedicated empty state
					     when `!hasStreams`, so no separate gate is needed at this call site. -->
					<UpcomingBillsCard widget={data.upcomingBills} />

					<div class="{cardBase} p-5">
						<div class="flex items-baseline justify-between gap-2">
							<h2 class="text-sm font-semibold tracking-tight text-zinc-900">
								{m.dashboard_forecast_title()}
							</h2>
							{#if data.cashFlowForecast.emptyState === null}
								<Badge tone="neutral">{m.dashboard_forecast_horizon_label()}</Badge>
							{/if}
						</div>
						{#if data.cashFlowForecast.emptyState === null}
							<div class="mt-2 flex flex-wrap items-baseline gap-2">
								<span
									class="text-2xl font-bold tabular-nums {forecastDeltaCents >= 0
										? 'text-emerald-700'
										: 'text-rose-600'}"
								>
									{forecastDeltaFormatted}
								</span>
								<span class="text-xs text-zinc-500">{m.dashboard_forecast_kpi_delta_suffix()}</span>
							</div>
							<div
								class="mt-0.5 text-xs {(forecastEnd?.balanceCents ?? 0) >= 0
									? 'text-emerald-700'
									: 'text-rose-600'}"
							>
								{labelledValue(
									m.dashboard_forecast_kpi_balance_label({ date: forecastEndDateFormatted }),
									formatCents(forecastEnd?.balanceCents ?? 0)
								)}
							</div>
							<div class="mt-3">
								<CashFlowForecastChart
									days={data.cashFlowForecast.days}
									todayIndex={data.cashFlowForecast.todayIndex}
									hasBalanceAnchor={data.cashFlowForecast.hasBalanceAnchor}
								/>
							</div>
						{:else}
							<!-- NO ACTION on either empty state, and that is the fix rather than an omission
							     (#202). See the twin comment in `src/routes/reports/+page.svelte`: both used to
							     offer `/reports#annexe-recurrences`, which renders behind
							     `{#if report.recurringPayments.length > 0}` on that page, from a list
							     anti-correlated with the state offering the link. The one action an empty state
							     offered did nothing, and giving the anchor a stable target would move the dead
							     end rather than remove it. The copy carries it instead. -->
							{#if data.cashFlowForecast.emptyState === 'all-stale'}
								<EmptyState
									class="mt-3"
									card={false}
									title={m.dashboard_forecast_stale_title()}
									description={m.dashboard_forecast_stale_description()}
								/>
							{:else}
								<EmptyState
									class="mt-3"
									card={false}
									title={m.dashboard_forecast_empty_title()}
									description={m.dashboard_forecast_empty_description()}
								/>
							{/if}
						{/if}
					</div>
				</div>
			</div>
		{/if}
	{/if}
</main>

<!-- Modal: manual entry -->
<Modal
	open={showManualModal}
	title={m.dashboard_manual_modal_title()}
	description={m.dashboard_manual_modal_description()}
	variant="compact"
	onClose={() => (showManualModal = false)}
>
	<!-- Visible mobile title: Modal's default header goes sr-only below lg
	     (see variant="compact"). Marked aria-hidden to avoid double-announcing
	     alongside that sr-only header, which already carries the dialog's accessible name. -->
	<p class="mb-4 text-lg font-bold text-zinc-950 lg:hidden" aria-hidden="true">
		{m.dashboard_manual_modal_title()}
	</p>
	<form
		class="grid gap-3"
		method="POST"
		action="?/createTransaction"
		use:enhance={() => {
			createTransactionSubmitting = true;
			return async ({ update }) => {
				await update();
				createTransactionSubmitting = false;
			};
		}}
	>
		<label class="grid gap-1 text-sm font-medium">
			{m.dashboard_field_date()}
			<input
				class="{inputBase} !bg-zinc-50 lg:!bg-white"
				name="date"
				type="date"
				value={getTodayDate()}
				required
			/>
		</label>
		<label class="grid gap-1 text-sm font-medium">
			{m.dashboard_field_label()}
			<input
				class="{inputBase} !bg-zinc-50 lg:!bg-white"
				name="label"
				type="text"
				maxlength="120"
				placeholder={m.dashboard_field_label_placeholder()}
				required
			/>
		</label>
		<MoneyInput
			name="amount"
			label={m.dashboard_field_amount()}
			placeholder={m.dashboard_field_amount_placeholder()}
			hint={m.dashboard_amount_hint()}
			allowZero={false}
			allowNegative={true}
			inputClass="!bg-zinc-50 lg:!bg-white"
		/>
		<label class="grid gap-1 text-sm font-medium">
			{m.budgets_field_category()}
			<Combobox
				name="category"
				value={manualTransactionCategory}
				options={data.categoryOptions.map((c) => ({ value: c, label: categoryDisplayName(c) }))}
				placeholder={m.dashboard_category_placeholder()}
				ariaLabel={m.budgets_field_category()}
				triggerClass="!bg-zinc-50 lg:!bg-white"
				onValueChange={(v) => (manualTransactionCategory = v)}
				required
			/>
		</label>
		{#if form?.createTransactionError}
			<!-- `AlertBanner variant="error"` rather than a red paragraph, because a refused save that
			     only changes colour is not perceivable to a screen-reader user: the banner carries
			     `aria-live="assertive"`, a hand-rolled `<p>` carries nothing. This is the surface the
			     category field's refusal now arrives on — see `Combobox.svelte`'s `required`. -->
			<AlertBanner variant="error">{form.createTransactionError}</AlertBanner>
		{/if}
		<div class="flex gap-2 border-t border-zinc-100 pt-3 lg:justify-end">
			<TapLink
				class="flex-1 justify-center lg:flex-none"
				onclick={() => (showManualModal = false)}
				disabled={createTransactionSubmitting}>{m.common_cancel()}</TapLink
			>
			<Button
				type="submit"
				class="flex-1 lg:flex-none"
				size="sm"
				loading={createTransactionSubmitting}>{m.dashboard_submit_add()}</Button
			>
		</div>
	</form>
</Modal>
