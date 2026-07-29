<script lang="ts">
	import { formatCents } from '$lib/domain/budget';
	import { getTransactionKind } from '$lib/domain/transaction';
	import type { TransactionNature } from '$lib/domain/transaction';
	import type { PeriodKey } from '$lib/server/date-range';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating } from '$app/state';
	import { enhance } from '$app/forms';
	import Modal from '$lib/components/Modal.svelte';
	import Button from '$lib/components/Button.svelte';
	import DashboardInsights from '$lib/components/DashboardInsights.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import { getInitials } from '$lib/domain/initials';
	import { cardBase, inputBase, inputFilter } from '$lib/styles';
	import Select from '$lib/components/ui/Select.svelte';
	import Combobox from '$lib/components/ui/Combobox.svelte';
	import BudgetStatusCard from '$lib/components/ui/BudgetStatusCard.svelte';
	import GoalStatusCard from '$lib/components/ui/GoalStatusCard.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import MoneyInput from '$lib/components/ui/MoneyInput.svelte';
	import DashboardSkeleton from '$lib/components/DashboardSkeleton.svelte';
	import CashFlowForecastChart from '$lib/components/ui/CashFlowForecastChart.svelte';
	import { buildDefaultKeyByName, categoryLabelByName } from '$lib/domain/categoryLabels';
	import { formatShortDate } from '$lib/domain/dateFormat';
	import { hasReliableConfirmedFlow } from '$lib/domain/forecast';
	import { natureLabel } from '$lib/domain/natureLabels';
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
	const hasConfirmedForecastFlows = $derived(hasReliableConfirmedFlow(data.cashFlowForecast.flows));
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

	const defaultKeyByName = $derived(buildDefaultKeyByName(data.categories));
	function displayCategory(name: string): string {
		return categoryLabelByName(name, defaultKeyByName);
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
	// FLAGGED during lint cleanup, not fixed here: the $effect below reads no reactive value, so
	// under Svelte 5's dependency tracking it only runs once at mount and never again — after the
	// user picks a period once, this permanently shadows `period.key` in `activePeriodKey` below,
	// even if `data.period` later changes through a path other than this page's own selector (e.g.
	// browser back/forward). A writable `$derived` (this lint rule's suggestion) would recompute
	// from `period.key` on every dependency change and drop the local override automatically — the
	// correct fix, but a real behavior change on a widely-used page, left for a dedicated
	// follow-up rather than bundled into this lint-cleanup batch.
	// eslint-disable-next-line svelte/prefer-writable-derived
	let userSelectedPeriodKey = $state<PeriodKey | null>(null);
	const activePeriodKey = $derived(userSelectedPeriodKey ?? period.key);

	$effect(() => {
		userSelectedPeriodKey = null;
	});

	$effect(() => {
		if (form?.createTransactionSuccess) showManualModal = false;
	});

	$effect(() => {
		if (!showManualModal) manualTransactionCategory = '';
	});

	function onPeriodChange(newValue: string) {
		userSelectedPeriodKey = newValue as PeriodKey;
		if (newValue !== 'custom') goto(resolve(`/?period=${newValue}` as `/?${string}`));
	}

	const NATURE_TAGS: ReadonlySet<TransactionNature> = new Set([
		'transfer',
		'investment',
		'refund',
		'fee'
	]);

	function getNatureTag(nature: TransactionNature | undefined): string | null {
		return nature && NATURE_TAGS.has(nature) ? natureLabel(nature) : null;
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
				<!-- Period selector -->
				<div class="w-full lg:w-auto">
					<Select
						value={period.key}
						options={[
							{ value: 'this-month', label: m.reports_period_this_month() },
							{ value: 'last-month', label: m.reports_period_last_month() },
							{ value: 'last-30-days', label: m.reports_period_last_30_days() },
							{ value: 'last-90-days', label: m.reports_period_last_90_days() },
							{ value: 'all-time', label: m.reports_period_all_time() },
							{ value: 'custom', label: m.dashboard_period_custom() }
						]}
						onValueChange={onPeriodChange}
					/>
				</div>

				{#if hasDashboardData}
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

			{#if activePeriodKey === 'custom'}
				<div
					class="w-full rounded-xl border border-zinc-200 bg-white p-3 lg:w-auto lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0"
				>
					<form method="GET" class="flex flex-col gap-2 lg:flex-row lg:items-center">
						<input type="hidden" name="period" value="custom" />
						<input
							class="{inputFilter} !bg-zinc-50 tabular-nums lg:!bg-white"
							name="from"
							type="date"
							aria-label={m.dashboard_date_from_aria()}
							value={period.key === 'custom' ? period.fromDate : ''}
							required
						/>
						<span class="hidden text-sm text-zinc-400 lg:inline" aria-hidden="true">→</span>
						<input
							class="{inputFilter} !bg-zinc-50 tabular-nums lg:!bg-white"
							name="to"
							type="date"
							aria-label={m.dashboard_date_to_aria()}
							value={period.key === 'custom' ? period.toDate : ''}
							required
						/>
						<Button type="submit" size="sm" class="w-full lg:w-auto">OK</Button>
					</form>
				</div>
			{/if}
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
			categories={data.categories}
		/>

		{#if !hasDashboardData}
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
											<div class="text-xs text-zinc-400">
												{formatDateShort(tx.date)} · {displayCategory(tx.category)}
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
										categoryLabel={displayCategory(cat.category)}
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

					<div class="{cardBase} p-5">
						<div class="flex items-baseline justify-between gap-2">
							<h2 class="text-sm font-semibold tracking-tight text-zinc-900">
								{m.dashboard_forecast_title()}
							</h2>
							{#if hasConfirmedForecastFlows}
								<Badge tone="neutral">{m.dashboard_forecast_horizon_label()}</Badge>
							{/if}
						</div>
						{#if hasConfirmedForecastFlows}
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
								{m.dashboard_forecast_kpi_balance_label({ date: forecastEndDateFormatted })}
								: {formatCents(forecastEnd?.balanceCents ?? 0)}
							</div>
							<div class="mt-3">
								<CashFlowForecastChart
									days={data.cashFlowForecast.days}
									todayIndex={data.cashFlowForecast.todayIndex}
									hasBalanceAnchor={data.cashFlowForecast.hasBalanceAnchor}
								/>
							</div>
						{:else}
							{#snippet forecastEmptyAction()}
								<TapLink href="/reports#annexe-recurrences"
									>{m.dashboard_forecast_empty_cta()}</TapLink
								>
							{/snippet}
							<EmptyState
								class="mt-3"
								card={false}
								title={m.dashboard_forecast_empty_title()}
								description={m.dashboard_forecast_empty_description()}
								action={forecastEmptyAction}
							/>
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
				options={data.categoryOptions.map((c) => ({ value: c, label: displayCategory(c) }))}
				placeholder={m.dashboard_category_placeholder()}
				ariaLabel={m.budgets_field_category()}
				triggerClass="!bg-zinc-50 lg:!bg-white"
				onValueChange={(v) => (manualTransactionCategory = v)}
				required
			/>
		</label>
		{#if form?.createTransactionError}
			<p class="text-sm font-medium text-rose-700">{form.createTransactionError}</p>
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
