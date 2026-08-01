<script lang="ts">
	import { formatCents } from '$lib/domain/budget';
	import {
		CATEGORY_PALETTE,
		CATEGORY_PALETTE_OTHERS,
		NATURE_COLORS,
		hexToBgClass
	} from '$lib/domain/colors';
	import { widthClass } from '$lib/domain/widthClass';
	import { buildDefaultKeyByName, categoryLabelByName } from '$lib/domain/categoryLabels';
	import { natureLabel } from '$lib/domain/natureLabels';
	import { takeawayDot, takeawayText as resolveTakeawayText } from '$lib/domain/takeawayLabels';
	import type { Takeaway } from '$lib/server/reports/monthly';
	import type { PageData } from './$types';
	import Button from '$lib/components/Button.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import DonutChart, { type DonutSegment } from '$lib/components/ui/DonutChart.svelte';
	import { cardBase, inputFilter } from '$lib/styles';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import CashFlowForecastChart from '$lib/components/ui/CashFlowForecastChart.svelte';
	import type { FlowCadence, FlowConfidenceTier } from '$lib/domain/forecast';
	import * as m from '$lib/paraglide/messages';

	let { data }: { data: PageData } = $props();
	const report = $derived(data.report);
	const period = $derived(data.period);
	const cashFlowForecast = $derived(data.cashFlowForecast);
	const forecastHorizonMonths = $derived(data.forecastHorizonMonths);
	// "Included in the calculation" table: only the flows that actually feed the projection ledger
	// right now (`feedsProjection`, computed server-side from `feedsCashFlowProjection`) — a
	// low-confidence, merely-tentative, or gone-stale flow only ever appears in the Annexes'
	// exhaustive table.
	const includedForecastFlows = $derived(
		cashFlowForecast.flows.filter((flow) => flow.feedsProjection)
	);

	const hasData = $derived(report.transactionCount > 0);

	const defaultKeyByName = $derived(buildDefaultKeyByName(data.categories));
	function displayCategory(name: string): string {
		return categoryLabelByName(name, defaultKeyByName);
	}

	type NatureSegment = { label: string; color: string; cents: number; pct: number };

	function buildNatureSegments(na: typeof report.natureAnalysis): NatureSegment[] {
		const raw = [
			{ nature: 'spending' as const, cents: na.spendingCents },
			{ nature: 'investment' as const, cents: na.investmentCents },
			{ nature: 'transfer' as const, cents: na.transferCents },
			{ nature: 'fee' as const, cents: na.feeCents },
			{ nature: 'uncategorized' as const, cents: na.uncategorizedCents }
		];
		const total = raw.reduce((s, seg) => s + seg.cents, 0) || 1;
		return raw
			.filter((seg) => seg.cents > 0)
			.map((seg) => ({
				label: natureLabel(seg.nature),
				color: NATURE_COLORS[seg.nature] ?? CATEGORY_PALETTE_OTHERS,
				cents: seg.cents,
				pct: (seg.cents / total) * 100
			}));
	}

	function buildCategoryDonutSegments(
		categories: Array<{ category: string; percentageOfExpenses: number }>
	): DonutSegment[] {
		return categories.slice(0, 5).map((category, i) => ({
			label: displayCategory(category.category),
			color: CATEGORY_PALETTE[i] ?? CATEGORY_PALETTE_OTHERS,
			pct: category.percentageOfExpenses * 100
		}));
	}

	const natureSegments = $derived(buildNatureSegments(report.natureAnalysis));
	const categoryDonutSegments = $derived(buildCategoryDonutSegments(report.topCategories));
	const categoryDonutMeta = $derived(
		`${formatCents(report.expenseCents)} · ${
			report.topCategories.length > 1
				? m.reports_donut_category_count_many({ count: report.topCategories.length })
				: m.reports_donut_category_count_one({ count: report.topCategories.length })
		}`
	);

	function formatPercent(value: number | null): string {
		if (value === null) return m.reports_not_available();
		return `${Math.round(value * 100)} %`;
	}

	function formatDelta(amountCents: number): string {
		const sign = amountCents > 0 ? '+' : '';
		return `${sign}${formatCents(amountCents)}`;
	}

	function takeawaySegments(takeaway: Takeaway): Array<{ text: string; bold: boolean }> {
		const text = resolveTakeawayText(takeaway, displayCategory);
		return text.split('**').map((segment, i) => ({ text: segment, bold: i % 2 === 1 }));
	}

	function confidenceLabel(confidence: 'faible' | 'moyenne' | 'haute'): string {
		if (confidence === 'haute') return m.reports_confidence_high();
		if (confidence === 'moyenne') return m.reports_confidence_medium();
		return m.reports_confidence_low();
	}

	function forecastConfidenceLabel(tier: FlowConfidenceTier): string {
		if (tier === 'high') return m.reports_confidence_high();
		if (tier === 'medium') return m.reports_confidence_medium();
		return m.reports_confidence_low();
	}

	function forecastCadenceLabel(cadence: FlowCadence): string {
		if (cadence === 'weekly') return m.reports_forecast_cadence_weekly();
		if (cadence === 'biweekly') return m.reports_forecast_cadence_biweekly();
		if (cadence === 'monthly') return m.reports_forecast_cadence_monthly();
		if (cadence === 'quarterly') return m.reports_forecast_cadence_quarterly();
		return m.reports_forecast_cadence_yearly();
	}

	// Confidence tone mapping is a fixed design decision — never 'danger': a low-confidence
	// recurrence isn't an error, just a softer signal (elevated = success, medium = warning, low =
	// neutral).
	function forecastConfidenceTone(tier: FlowConfidenceTier): 'success' | 'warning' | 'neutral' {
		if (tier === 'high') return 'success';
		if (tier === 'medium') return 'warning';
		return 'neutral';
	}

	// averageAmountCents is always a positive magnitude (RecurringFlow never stores a signed
	// amount) — the sign here is derived purely from direction, mirroring formatDelta()'s
	// sign-prefix convention above so income/expense isn't color-only.
	function formatFlowAmount(direction: 'income' | 'expense', amountCents: number): string {
		const sign = direction === 'income' ? '+' : '-';
		return `${sign}${formatCents(amountCents)}`;
	}
</script>

<svelte:head>
	<title>{m.reports_page_title()}</title>
</svelte:head>

<main class="min-h-screen bg-zinc-50 px-4 py-8 text-zinc-900 sm:px-6 lg:px-8">
	<div class="mx-auto max-w-6xl space-y-6">
		<!-- 1 · TITRE + FILTRE PÉRIODE -->
		<div class="flex flex-wrap items-end justify-between gap-4">
			<div>
				<h1 class="text-xl font-semibold tracking-tight">{m.reports_heading()}</h1>
				<p class="mt-1 text-sm text-zinc-500">
					{m.reports_subtitle()}
				</p>
			</div>
			<form class="hidden flex-wrap items-end gap-2 lg:flex" method="GET" id="period-form">
				<div>
					<p class="block text-sm font-medium text-zinc-600">{m.reports_period_label()}</p>
					<div class="mt-1">
						<Select
							name="period"
							value={period.key}
							ariaLabel={m.reports_period_label()}
							options={[
								{ value: 'this-month', label: m.reports_period_this_month() },
								{ value: 'last-month', label: m.reports_period_last_month() },
								{ value: 'last-30-days', label: m.reports_period_last_30_days() },
								{ value: 'last-90-days', label: m.reports_period_last_90_days() },
								{ value: 'all-time', label: m.reports_period_all_time() },
								{ value: 'custom', label: m.reports_period_custom() }
							]}
						/>
					</div>
				</div>
				<div>
					<label for="rpt-from" class="block text-sm font-medium text-zinc-600">
						{m.reports_from_label()}
					</label>
					<input
						id="rpt-from"
						class="mt-1 {inputFilter} tabular-nums"
						name="from"
						type="date"
						value={period.fromDate}
					/>
				</div>
				<div>
					<label for="rpt-to" class="block text-sm font-medium text-zinc-600">
						{m.reports_to_label()}
					</label>
					<input
						id="rpt-to"
						class="mt-1 {inputFilter} tabular-nums"
						name="to"
						type="date"
						value={period.toDate}
					/>
				</div>
				<Button type="submit" size="field">{m.reports_submit()}</Button>
			</form>
		</div>

		<!-- 1 · SÉLECTEUR DE PÉRIODE (mobile) -->
		<form class="space-y-4 {cardBase} p-5 lg:hidden" method="GET" id="period-form-mobile">
			<div>
				<p class="block text-sm font-medium text-zinc-600">{m.reports_period_label()}</p>
				<div class="mt-1.5">
					<Select
						name="period"
						value={period.key}
						ariaLabel={m.reports_period_label()}
						class="!bg-zinc-50"
						options={[
							{ value: 'this-month', label: m.reports_period_this_month() },
							{ value: 'last-month', label: m.reports_period_last_month() },
							{ value: 'last-30-days', label: m.reports_period_last_30_days() },
							{ value: 'last-90-days', label: m.reports_period_last_90_days() },
							{ value: 'all-time', label: m.reports_period_all_time() },
							{ value: 'custom', label: m.reports_period_custom() }
						]}
					/>
				</div>
			</div>
			<div>
				<label for="rpt-from-mobile" class="block text-sm font-medium text-zinc-600">
					{m.reports_from_label()}
				</label>
				<input
					id="rpt-from-mobile"
					class="mt-1.5 w-full {inputFilter} !bg-zinc-50 tabular-nums"
					name="from"
					type="date"
					value={period.fromDate}
				/>
			</div>
			<div>
				<label for="rpt-to-mobile" class="block text-sm font-medium text-zinc-600">
					{m.reports_to_label()}
				</label>
				<input
					id="rpt-to-mobile"
					class="mt-1.5 w-full {inputFilter} !bg-zinc-50 tabular-nums"
					name="to"
					type="date"
					value={period.toDate}
				/>
			</div>
			<Button type="submit" class="!flex h-11 w-full items-center justify-center"
				>{m.reports_submit()}</Button
			>
		</form>

		<!-- KPI STRIP (desktop) -->
		<div
			class="hidden grid-cols-2 divide-x divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 bg-white sm:grid-cols-3 lg:grid lg:grid-cols-6"
		>
			<div class="border-t-2 border-zinc-300 px-4 py-3.5">
				<div class="text-[10px] font-bold tracking-wide text-zinc-500 uppercase">
					{m.reports_kpi_income()}
				</div>
				<div class="mt-1 text-2xl font-bold text-emerald-600 tabular-nums">
					{formatCents(report.incomeCents)}
				</div>
				{#if report.previousMonth}
					<div class="mt-0.5 text-xs text-zinc-400">
						{m.reports_delta_vs({
							delta: formatDelta(report.previousMonth.incomeDeltaCents),
							month: report.previousMonth.month
						})}
					</div>
				{/if}
			</div>
			<div class="border-t-2 border-zinc-300 px-4 py-3.5">
				<div class="text-[10px] font-bold tracking-wide text-zinc-500 uppercase">
					{m.reports_kpi_expense()}
				</div>
				<div class="mt-1 text-2xl font-bold text-rose-600 tabular-nums">
					{formatCents(report.expenseCents)}
				</div>
				{#if report.previousMonth}
					<div class="mt-0.5 text-xs text-zinc-400">
						{m.reports_delta_vs({
							delta: formatDelta(report.previousMonth.expenseDeltaCents),
							month: report.previousMonth.month
						})}
					</div>
				{/if}
			</div>
			<div class="border-t-2 border-zinc-300 px-4 py-3.5">
				<div class="text-[10px] font-bold tracking-wide text-zinc-500 uppercase">
					{m.reports_kpi_balance()}
				</div>
				<div
					class="mt-1 text-2xl font-bold tabular-nums {report.balanceCents >= 0
						? 'text-emerald-600'
						: 'text-rose-600'}"
				>
					{formatCents(report.balanceCents)}
				</div>
				{#if report.previousMonth}
					<div class="mt-0.5 text-xs text-zinc-400">
						{m.reports_delta_vs({
							delta: formatDelta(report.previousMonth.balanceDeltaCents),
							month: report.previousMonth.month
						})}
					</div>
				{/if}
			</div>
			<div class="border-t-2 border-zinc-300 px-4 py-3.5">
				<div class="text-[10px] font-bold tracking-wide text-zinc-500 uppercase">
					{m.reports_kpi_transactions()}
				</div>
				<div class="mt-1 text-2xl font-bold text-zinc-900 tabular-nums">
					{report.transactionCount}
				</div>
			</div>
			<div class="border-t-2 border-zinc-300 px-4 py-3.5">
				<div class="text-[10px] font-bold tracking-wide text-zinc-500 uppercase">
					{m.reports_kpi_expense_per_day()}
				</div>
				<div class="mt-1 text-2xl font-bold text-zinc-900 tabular-nums">
					{formatCents(report.expenseAveragePerDayCents)}
				</div>
			</div>
			<div class="border-t-2 border-zinc-300 px-4 py-3.5">
				<div class="text-[10px] font-bold tracking-wide text-zinc-500 uppercase">
					{m.reports_kpi_savings_rate()}
				</div>
				<div
					class="mt-1 text-2xl font-bold tabular-nums {report.savingsRate === null
						? 'text-zinc-400'
						: report.savingsRate >= 0.1
							? 'text-indigo-600'
							: report.savingsRate >= 0
								? 'text-emerald-600'
								: 'text-rose-600'}"
				>
					{formatPercent(report.savingsRate)}
				</div>
			</div>
		</div>

		<!-- KPI (mobile) : 3 cartes à 2 colonnes -->
		<div class="grid grid-cols-1 gap-3 lg:hidden">
			<div class="grid grid-cols-2 divide-x divide-zinc-200 {cardBase} p-4">
				<div class="pr-4">
					<div class="text-[10px] font-bold tracking-wide text-zinc-500 uppercase">
						{m.reports_kpi_income()}
					</div>
					<div class="mt-1 text-2xl font-bold text-emerald-600 tabular-nums">
						{formatCents(report.incomeCents)}
					</div>
					{#if report.previousMonth}
						<div class="mt-0.5 text-xs text-zinc-400">
							{m.reports_delta_vs({
								delta: formatDelta(report.previousMonth.incomeDeltaCents),
								month: report.previousMonth.month
							})}
						</div>
					{/if}
				</div>
				<div class="pl-4">
					<div class="text-[10px] font-bold tracking-wide text-zinc-500 uppercase">
						{m.reports_kpi_expense()}
					</div>
					<div class="mt-1 text-2xl font-bold text-rose-600 tabular-nums">
						{formatCents(report.expenseCents)}
					</div>
					{#if report.previousMonth}
						<div class="mt-0.5 text-xs text-zinc-400">
							{m.reports_delta_vs({
								delta: formatDelta(report.previousMonth.expenseDeltaCents),
								month: report.previousMonth.month
							})}
						</div>
					{/if}
				</div>
			</div>
			<div class="grid grid-cols-2 divide-x divide-zinc-200 {cardBase} p-4">
				<div class="pr-4">
					<div class="text-[10px] font-bold tracking-wide text-zinc-500 uppercase">
						{m.reports_kpi_balance()}
					</div>
					<div
						class="mt-1 text-2xl font-bold tabular-nums {report.balanceCents >= 0
							? 'text-emerald-600'
							: 'text-rose-600'}"
					>
						{formatCents(report.balanceCents)}
					</div>
					{#if report.previousMonth}
						<div class="mt-0.5 text-xs text-zinc-400">
							{m.reports_delta_vs({
								delta: formatDelta(report.previousMonth.balanceDeltaCents),
								month: report.previousMonth.month
							})}
						</div>
					{/if}
				</div>
				<div class="pl-4">
					<div class="text-[10px] font-bold tracking-wide text-zinc-500 uppercase">
						{m.reports_kpi_transactions()}
					</div>
					<div class="mt-1 text-2xl font-bold text-zinc-900 tabular-nums">
						{report.transactionCount}
					</div>
				</div>
			</div>
			<div class="grid grid-cols-2 divide-x divide-zinc-200 {cardBase} p-4">
				<div class="pr-4">
					<div class="text-[10px] font-bold tracking-wide text-zinc-500 uppercase">
						{m.reports_kpi_expense_per_day()}
					</div>
					<div class="mt-1 text-2xl font-bold text-zinc-900 tabular-nums">
						{formatCents(report.expenseAveragePerDayCents)}
					</div>
				</div>
				<div class="pl-4">
					<div class="text-[10px] font-bold tracking-wide text-zinc-500 uppercase">
						{m.reports_kpi_savings_rate()}
					</div>
					<div
						class="mt-1 text-2xl font-bold tabular-nums {report.savingsRate === null
							? 'text-zinc-400'
							: report.savingsRate >= 0.1
								? 'text-indigo-600'
								: report.savingsRate >= 0
									? 'text-emerald-600'
									: 'text-rose-600'}"
					>
						{formatPercent(report.savingsRate)}
					</div>
				</div>
			</div>
		</div>

		{#if !hasData}
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
					<path d="M3 3v18h18" />
					<path d="m7 14 3-3 3 3 4-5" />
				</svg>
			{/snippet}
			{#snippet emptyAction()}
				<div class="mt-1 flex w-full flex-col items-center gap-2 sm:w-auto sm:flex-row">
					<Button href="/imports" class="w-full sm:w-auto">
						{m.reports_empty_import_cta()}
					</Button>
					<Button
						class="w-full sm:w-auto"
						variant="secondary"
						form="period-form-mobile"
						type="submit">{m.reports_empty_change_period_cta()}</Button
					>
				</div>
			{/snippet}
			<EmptyState
				icon={emptyIcon}
				title={m.reports_empty_heading()}
				description={m.reports_empty_description()}
				action={emptyAction}
			/>
		{:else}
			<!-- 2 · À RETENIR -->
			{#if report.takeaways.length > 0}
				<div class="{cardBase} p-5">
					<h2 class="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
						{m.reports_takeaways_heading()}
					</h2>
					<ul class="mt-3 space-y-2.5">
						{#each report.takeaways as takeaway (takeaway.code)}
							<li class="flex items-start gap-2.5 text-sm text-zinc-700">
								<span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full {takeawayDot(takeaway.code)}"
								></span>
								<span
									>{#each takeawaySegments(takeaway) as segment, i (i)}{#if segment.bold}<strong
												class="font-semibold text-zinc-900">{segment.text}</strong
											>{:else}{segment.text}{/if}{/each}</span
								>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			<!-- 3 · ANALYSE VISUELLE -->
			<div>
				<h2 class="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
					{m.reports_analysis_heading()}
				</h2>
				<div class="mt-3 grid gap-4 lg:grid-cols-2">
					<!-- Donut : Sorties par catégorie -->
					<div class="{cardBase} p-5">
						<DonutChart
							segments={categoryDonutSegments}
							othersColor={CATEGORY_PALETTE_OTHERS}
							title={m.reports_donut_title()}
							meta={categoryDonutMeta}
							centerCaption={m.reports_donut_total_label()}
							centerValue={`${Math.round(report.expenseCents / 100)} €`}
							emptyText={m.reports_empty_no_expense()}
						/>
					</div>

					<!-- Barre empilée : Sorties par nature -->
					<div class="{cardBase} p-5">
						<div class="flex items-baseline justify-between">
							<h3 class="text-sm font-semibold tracking-tight text-zinc-900">
								{m.reports_nature_title()}
							</h3>
						</div>
						{#if natureSegments.length > 0}
							<div class="mt-4 flex h-8 w-full overflow-hidden rounded-md ring-1 ring-zinc-200">
								{#each natureSegments as segment (segment.label)}
									<Tooltip
										label="{segment.label} : {formatCents(segment.cents)}"
										wrapperClass="contents"
									>
										<!-- Purely informative segment (no click action) made focusable so its
											 Tooltip is reachable via keyboard, per the "never hover-only" rule.
											 No interactive role is added on purpose (nothing happens on activation). -->
										<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
										<div
											aria-label="{segment.label} : {formatCents(segment.cents)}"
											tabindex="0"
											class="relative flex items-center justify-center text-[11px] font-semibold text-white {widthClass(
												segment.pct
											)} {hexToBgClass(segment.color)}"
										>
											{#if segment.pct >= 12}{Math.round(segment.pct)} %{/if}
										</div>
									</Tooltip>
								{/each}
							</div>
							<ul class="mt-4 space-y-2 text-[13px]">
								{#each natureSegments as segment (segment.label)}
									<li class="flex items-center gap-2">
										<span class="h-2.5 w-2.5 shrink-0 rounded-sm {hexToBgClass(segment.color)}"
										></span>
										<span class="flex-1 text-zinc-700">{segment.label}</span>
										<span class="font-medium text-zinc-900 tabular-nums">
											{formatCents(segment.cents)}
										</span>
									</li>
								{/each}
							</ul>
						{:else}
							<p class="mt-4 text-sm text-zinc-500">{m.reports_nature_empty()}</p>
						{/if}
					</div>
				</div>
			</div>

			<!-- 4 · Top catégories + Plus grosses dépenses -->
			<div>
				<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
					<!-- desktop -->
					<div class="hidden overflow-hidden rounded-lg border border-zinc-200 bg-white lg:block">
						<div class="border-b border-zinc-100 px-5 py-3">
							<h3 class="text-sm font-semibold tracking-tight text-zinc-900">
								{m.reports_top_categories_title()}
							</h3>
						</div>
						{#if report.topCategories.length > 0}
							<table class="w-full text-sm">
								<thead>
									<tr class="text-[11px] tracking-wide text-zinc-400 uppercase">
										<th class="px-5 py-2 text-left font-medium"
											>{m.reports_top_categories_table_category()}</th
										>
										<th class="px-5 py-2 text-right font-medium"
											>{m.reports_top_categories_table_transactions()}</th
										>
										<th class="px-5 py-2 text-right font-medium"
											>{m.reports_top_categories_table_share()}</th
										>
									</tr>
								</thead>
								<tbody class="divide-y divide-zinc-100">
									{#each report.topCategories as category, i (category.category)}
										<tr>
											<td class="px-5 py-3">
												<div class="font-medium text-zinc-900">
													{displayCategory(category.category)}
												</div>
												<div class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
													<div
														class="h-full rounded-full {widthClass(
															category.percentageOfExpenses * 100
														)} {hexToBgClass(CATEGORY_PALETTE[i] ?? CATEGORY_PALETTE_OTHERS)}"
													></div>
												</div>
											</td>
											<td class="px-5 py-3 text-right text-zinc-500 tabular-nums">
												{category.transactionCount}
											</td>
											<td class="px-5 py-3 text-right font-medium text-rose-600 tabular-nums">
												{Math.round(category.percentageOfExpenses * 100)} %
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						{:else}
							<p class="px-5 py-4 text-sm text-zinc-500">{m.reports_empty_no_expense()}</p>
						{/if}
					</div>

					<!-- mobile -->
					<div class="lg:hidden">
						<h3 class="px-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
							{m.reports_top_categories_title()}
						</h3>
						{#if report.topCategories.length > 0}
							<div class="mt-3 space-y-2.5">
								{#each report.topCategories as category, i (category.category)}
									<div class="{cardBase} p-4">
										<div class="flex items-baseline justify-between gap-3">
											<span class="truncate text-sm font-semibold text-zinc-900"
												>{displayCategory(category.category)}</span
											>
											<div class="flex shrink-0 items-baseline gap-3">
												<span class="text-xs text-zinc-500 tabular-nums">
													{category.transactionCount === 1
														? m.reports_top_categories_count_one({
																count: category.transactionCount
															})
														: m.reports_top_categories_count_many({
																count: category.transactionCount
															})}
												</span>
												<span class="text-sm font-semibold text-zinc-900 tabular-nums">
													{Math.round(category.percentageOfExpenses * 100)} %
												</span>
											</div>
										</div>
										<div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
											<div
												class="h-full rounded-full {widthClass(
													category.percentageOfExpenses * 100
												)} {hexToBgClass(CATEGORY_PALETTE[i] ?? CATEGORY_PALETTE_OTHERS)}"
											></div>
										</div>
									</div>
								{/each}
							</div>
						{:else}
							<p class="mt-3 {cardBase} px-5 py-4 text-sm text-zinc-500">
								{m.reports_empty_no_expense()}
							</p>
						{/if}
					</div>

					<!-- desktop -->
					<div class="hidden overflow-hidden rounded-lg border border-zinc-200 bg-white lg:block">
						<div class="border-b border-zinc-100 px-5 py-3">
							<h3 class="text-sm font-semibold tracking-tight text-zinc-900">
								{m.reports_largest_expenses_title()}
							</h3>
						</div>
						{#if report.largestExpenses.length > 0}
							<table class="w-full text-sm">
								<thead>
									<tr class="text-[11px] tracking-wide text-zinc-400 uppercase">
										<th class="px-5 py-2 text-left font-medium"
											>{m.reports_largest_expenses_table_label()}</th
										>
										<th class="px-5 py-2 text-left font-medium"
											>{m.reports_largest_expenses_table_category()}</th
										>
										<th class="px-5 py-2 text-right font-medium"
											>{m.reports_largest_expenses_table_amount()}</th
										>
									</tr>
								</thead>
								<tbody class="divide-y divide-zinc-100">
									{#each report.largestExpenses as expense, i (i)}
										<tr>
											<td class="px-5 py-3 font-medium text-zinc-900">{expense.label}</td>
											<td class="px-5 py-3 text-zinc-500">{displayCategory(expense.category)}</td>
											<td class="px-5 py-3 text-right font-semibold text-rose-600 tabular-nums">
												{formatCents(expense.amountCents)}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						{:else}
							<p class="px-5 py-4 text-sm text-zinc-500">{m.reports_empty_no_expense_detail()}</p>
						{/if}
					</div>

					<!-- mobile -->
					<div class="lg:hidden">
						<h3 class="px-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
							{m.reports_largest_expenses_title()}
						</h3>
						{#if report.largestExpenses.length > 0}
							<div class="mt-3 space-y-2.5">
								{#each report.largestExpenses as expense, i (i)}
									<div class="flex items-center justify-between gap-3 {cardBase} p-4">
										<div class="min-w-0">
											<div class="truncate text-sm font-semibold text-zinc-900">
												{expense.label}
											</div>
											<div class="mt-0.5 truncate text-xs text-zinc-500">
												{displayCategory(expense.category)}
											</div>
										</div>
										<div class="shrink-0 text-sm font-semibold text-rose-600 tabular-nums">
											{formatCents(expense.amountCents)}
										</div>
									</div>
								{/each}
							</div>
						{:else}
							<p class="mt-3 {cardBase} px-5 py-4 text-sm text-zinc-500">
								{m.reports_empty_no_expense_detail()}
							</p>
						{/if}
					</div>
				</div>
			</div>

			<!-- 5 · PRÉVISION DE TRÉSORERIE -->
			<div>
				<div class="flex items-center gap-2">
					<h2 class="text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">
						{m.reports_forecast_heading()}
					</h2>
					<div class="h-px flex-1 bg-zinc-200"></div>
				</div>

				{#if cashFlowForecast.emptyState === null}
					<div class="mt-3 {cardBase} p-5">
						<h3 class="text-sm font-medium text-zinc-600">
							{m.reports_forecast_chart_title({ months: forecastHorizonMonths })}
						</h3>
						<div class="mt-3">
							<CashFlowForecastChart
								days={cashFlowForecast.days}
								todayIndex={cashFlowForecast.todayIndex}
								hasBalanceAnchor={cashFlowForecast.hasBalanceAnchor}
							/>
						</div>
					</div>

					<!-- desktop -->
					<div
						class="mt-3 hidden overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50/50 lg:block"
					>
						<div class="border-b border-zinc-100 px-5 py-3">
							<h3 class="text-sm font-medium text-zinc-600">{m.reports_forecast_flows_title()}</h3>
							<p class="mt-1 text-xs text-zinc-500">{m.reports_forecast_flows_intro()}</p>
						</div>
						<div class="overflow-x-auto">
							<table class="w-full min-w-[760px] text-sm">
								<thead>
									<tr class="text-[11px] tracking-wide text-zinc-400 uppercase">
										<th class="px-5 py-2 text-left font-medium"
											>{m.reports_forecast_table_label()}</th
										>
										<th class="px-5 py-2 text-left font-medium"
											>{m.reports_forecast_table_category()}</th
										>
										<th class="px-5 py-2 text-right font-medium"
											>{m.reports_forecast_table_cadence()}</th
										>
										<th class="px-5 py-2 text-right font-medium"
											>{m.reports_forecast_table_confidence()}</th
										>
										<th class="px-5 py-2 text-right font-medium"
											>{m.reports_forecast_table_amount()}</th
										>
									</tr>
								</thead>
								<tbody class="divide-y divide-zinc-100">
									{#each includedForecastFlows as flow (`${flow.label}:${flow.category}:${flow.direction}`)}
										<tr>
											<td class="px-5 py-3 font-medium text-zinc-700">{flow.label}</td>
											<td class="px-5 py-3 text-zinc-500">{displayCategory(flow.category)}</td>
											<td class="px-5 py-3 text-right text-zinc-500"
												>{forecastCadenceLabel(flow.cadence)}</td
											>
											<td class="px-5 py-3 text-right">
												<Badge tone={forecastConfidenceTone(flow.confidence)}
													>{forecastConfidenceLabel(flow.confidence)}</Badge
												>
											</td>
											<td
												class="px-5 py-3 text-right font-medium tabular-nums {flow.direction ===
												'income'
													? 'text-emerald-700'
													: 'text-rose-600'}"
											>
												{formatFlowAmount(flow.direction, flow.averageAmountCents)}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>

					<!-- mobile -->
					<div class="mt-3 lg:hidden">
						<h3 class="px-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
							{m.reports_forecast_flows_title()}
						</h3>
						<p class="mt-1 px-1 text-xs text-zinc-500">{m.reports_forecast_flows_intro()}</p>
						<div class="mt-3 space-y-2.5">
							{#each includedForecastFlows as flow (`${flow.label}:${flow.category}:${flow.direction}`)}
								<div class="{cardBase} p-4">
									<div class="flex items-start justify-between gap-3">
										<div class="min-w-0">
											<div class="truncate font-medium text-zinc-900">{flow.label}</div>
											<div class="mt-0.5 truncate text-xs text-zinc-500">
												{displayCategory(flow.category)}
											</div>
										</div>
										<span class="shrink-0">
											<Badge tone={forecastConfidenceTone(flow.confidence)}
												>{forecastConfidenceLabel(flow.confidence)}</Badge
											>
										</span>
									</div>
									<div class="mt-3 flex items-end justify-between gap-3">
										<div class="text-xs text-zinc-500">
											{forecastCadenceLabel(flow.cadence)}
										</div>
										<div
											class="shrink-0 font-semibold tabular-nums {flow.direction === 'income'
												? 'text-emerald-700'
												: 'text-rose-600'}"
										>
											{formatFlowAmount(flow.direction, flow.averageAmountCents)}
										</div>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{:else}
					<!-- Same CTA on both empty states. Kept for what the copy asks, not for a row-count
					     guarantee: it answers "which recurrences?", the question `all-stale`/`none-detected`
					     naturally raises. It is NOT proven to have anything to scroll to — the annexe table
					     is `report.recurringPayments` (getRecurringPayments, server/reports/monthly.ts),
					     built from the SELECTED PERIOD's expenses only (>=2 occurrences within that period,
					     income excluded, unrelated to the 12-month detector `cashFlowForecast` runs on). In
					     `all-stale` the two are close to anti-correlated: a stale stream is by definition
					     silent longer than one tolerated cycle, so within the current period it has 0 or 1
					     occurrence and cannot reach recurringPayments' own >= 2 gate — a subscription
					     cancelled last month can show `all-stale` here with an empty annexe table, so
					     `#annexe-recurrences` doesn't exist and the link scrolls nowhere. Pre-existing, same
					     dead anchor on `none-detected`; not fixed in this wave (tracked separately). -->
					{#snippet forecastEmptyAction()}
						<TapLink href="#annexe-recurrences">{m.reports_forecast_empty_cta()}</TapLink>
					{/snippet}
					{#if cashFlowForecast.emptyState === 'all-stale'}
						<EmptyState
							class="mt-3"
							title={m.reports_forecast_stale_title()}
							description={m.reports_forecast_stale_description()}
							action={forecastEmptyAction}
						/>
					{:else}
						<EmptyState
							class="mt-3"
							title={m.reports_forecast_empty_title()}
							description={m.reports_forecast_empty_description()}
							action={forecastEmptyAction}
						/>
					{/if}
				{/if}
			</div>

			<!-- 6 · ANNEXES -->
			{#if report.recurringPayments.length > 0}
				<div id="annexe-recurrences" class="scroll-mt-6">
					<div class="flex items-center gap-2">
						<h2 class="text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">
							{m.reports_appendix_heading()}
						</h2>
						<div class="h-px flex-1 bg-zinc-200"></div>
					</div>
					<!-- desktop -->
					<div
						class="mt-3 hidden overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50/50 lg:block"
					>
						<div class="border-b border-zinc-100 px-5 py-3">
							<h3 class="text-sm font-medium text-zinc-600">{m.reports_recurring_title()}</h3>
							<p class="mt-1 text-xs text-zinc-500">{m.reports_recurring_subtitle()}</p>
						</div>
						<div class="overflow-x-auto">
							<table class="w-full min-w-[760px] text-sm">
								<thead>
									<tr class="text-[11px] tracking-wide text-zinc-400 uppercase">
										<th class="px-5 py-2 text-left font-medium"
											>{m.reports_recurring_table_label()}</th
										>
										<th class="px-5 py-2 text-left font-medium"
											>{m.reports_recurring_table_category()}</th
										>
										<th class="px-5 py-2 text-right font-medium"
											>{m.reports_recurring_table_occurrences()}</th
										>
										<th class="px-5 py-2 text-right font-medium"
											>{m.reports_recurring_table_last_date()}</th
										>
										<th class="px-5 py-2 text-right font-medium"
											>{m.reports_recurring_table_confidence()}</th
										>
										<th class="px-5 py-2 text-right font-medium"
											>{m.reports_recurring_table_average()}</th
										>
										<th class="px-5 py-2 text-right font-medium"
											>{m.reports_recurring_table_total()}</th
										>
									</tr>
								</thead>
								<tbody class="divide-y divide-zinc-100">
									{#each report.recurringPayments as rec (`${rec.label}:${rec.category}:${rec.amountCents}`)}
										<tr>
											<td class="px-5 py-3 font-medium text-zinc-700">{rec.label}</td>
											<td class="px-5 py-3 text-zinc-500">{displayCategory(rec.category)}</td>
											<td class="px-5 py-3 text-right text-zinc-500 tabular-nums">{rec.count}</td>
											<td class="px-5 py-3 text-right text-zinc-500 tabular-nums">{rec.lastDate}</td
											>
											<td class="px-5 py-3 text-right text-zinc-500"
												>{confidenceLabel(rec.confidence)}</td
											>
											<td class="px-5 py-3 text-right font-medium text-zinc-700 tabular-nums">
												{formatCents(rec.amountCents)}
											</td>
											<td class="px-5 py-3 text-right font-medium text-zinc-700 tabular-nums">
												{formatCents(rec.totalAmountCents)}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>

					<!-- mobile -->
					<div class="mt-3 lg:hidden">
						<h3 class="px-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
							{m.reports_recurring_title()}
						</h3>
						<p class="mt-1 px-1 text-xs text-zinc-500">{m.reports_recurring_subtitle()}</p>
						<div class="mt-3 space-y-2.5">
							{#each report.recurringPayments as rec (`${rec.label}:${rec.category}:${rec.amountCents}`)}
								<div class="{cardBase} p-4">
									<div class="flex items-start justify-between gap-3">
										<div class="min-w-0">
											<div class="truncate font-medium text-zinc-900">{rec.label}</div>
											<div class="mt-0.5 truncate text-xs text-zinc-500">
												{displayCategory(rec.category)}
											</div>
										</div>
										<span class="shrink-0">
											<Badge tone="neutral">
												{m.reports_recurring_confidence_badge({
													level: confidenceLabel(rec.confidence)
												})}
											</Badge>
										</span>
									</div>
									<div class="mt-3 flex items-end justify-between gap-3">
										<div class="text-xs text-zinc-500">
											{rec.count === 1
												? m.reports_recurring_meta_one({ count: rec.count, date: rec.lastDate })
												: m.reports_recurring_meta_many({ count: rec.count, date: rec.lastDate })}
										</div>
										<div class="shrink-0 text-right">
											<div class="font-semibold text-zinc-900 tabular-nums">
												{formatCents(rec.amountCents)}
											</div>
											<div class="text-xs text-zinc-500 tabular-nums">
												{m.reports_recurring_table_total()}: {formatCents(rec.totalAmountCents)}
											</div>
										</div>
									</div>
								</div>
							{/each}
						</div>
					</div>
				</div>
			{/if}
		{/if}
	</div>
</main>
