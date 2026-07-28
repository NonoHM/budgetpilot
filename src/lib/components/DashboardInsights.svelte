<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatCents, formatBudgetDelta, formatSpentOfLimit } from '$lib/domain/budget';
	import { widthClass } from '$lib/domain/widthClass';
	import { buildDefaultKeyByName, categoryLabelByName } from '$lib/domain/categoryLabels';
	import type { DashboardInsights } from '$lib/server/dashboard/insights';
	import type { LocalAiAdvice } from '$lib/server/insights/types';
	import Badge from '$lib/components/ui/Badge.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import * as m from '$lib/paraglide/messages';

	let {
		insights,
		aiAdvice,
		aiAllowed,
		categories
	}: {
		insights: DashboardInsights;
		// A promise while the local model is still generating (the server streams it rather
		// than blocking the page on it). A plain value is accepted too, which keeps tests and
		// any non-streaming caller straightforward — `{#await}` resolves those immediately.
		aiAdvice: LocalAiAdvice | Promise<LocalAiAdvice | null> | null;
		aiAllowed: boolean;
		categories: Array<{ name: string; defaultKey: string | null }>;
	} = $props();

	const defaultKeyByName = $derived(buildDefaultKeyByName(categories));
	function displayCategory(name: string): string {
		return categoryLabelByName(name, defaultKeyByName);
	}

	const insightsHasContent = $derived(
		insights.alerts.length > 0 ||
			insights.unusualSpending !== null ||
			insights.uncategorizedCount > 0
	);
	// The AI card is the only thing that can still be pending, and the section has to render
	// for its placeholder to be visible at all — otherwise a user with no rule insights sees
	// nothing until the model finishes and the whole section pops in.
	const aiHasContent = $derived(aiAllowed);
	const totalAlertCount = $derived(insights.alerts.length + insights.alertOverflowCount);
	const worstAlertStatus = $derived(
		insights.alerts.some((alert) => alert.status === 'over_budget') ? 'over_budget' : 'near_limit'
	);

	// Collapsed by default on every breakpoint — identical mobile/desktop behavior.
	let insightsOpen = $state(false);
	let aiOpen = $state(false);

	function categoryHref(category: string) {
		return resolve(
			`/transactions?category=${encodeURIComponent(category)}` as `/transactions?${string}`
		);
	}
</script>

{#if insightsHasContent}
	<section class="mt-6">
		<div class="flex items-center justify-between gap-2">
			<button
				type="button"
				class="flex min-h-11 flex-1 items-center gap-2"
				onclick={() => (insightsOpen = !insightsOpen)}
				aria-expanded={insightsOpen}
				aria-controls="dashboard-insights-content"
			>
				<span class="text-sm font-semibold tracking-tight text-zinc-900"
					>{m.dashboard_insights_heading()}</span
				>
				{#if insights.alerts.length > 0}
					<Badge tone={worstAlertStatus === 'over_budget' ? 'danger' : 'warning'}>
						{m.dashboard_insights_alert_badge({ count: totalAlertCount })}
					</Badge>
				{/if}
				<svg
					class="ml-auto h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-150"
					class:rotate-180={insightsOpen}
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
			{#if insights.alertOverflowCount > 0 && insightsOpen}
				<div class="shrink-0">
					<TapLink href="/budgets">{m.dashboard_insights_see_all()}</TapLink>
				</div>
			{/if}
		</div>

		<div id="dashboard-insights-content" class={insightsOpen ? '' : 'hidden'}>
			{#if insights.alerts.length > 0}
				<div class="mt-3 grid gap-3 sm:grid-cols-2">
					{#each insights.alerts as alert (alert.category)}
						{@const usagePercentage = Math.min((alert.spentCents / alert.limitCents) * 100, 100)}
						{@const delta = formatBudgetDelta(alert.spentCents, alert.limitCents)}
						<div
							class="rounded-3xl border p-4 lg:rounded-lg {alert.status === 'over_budget'
								? 'border-rose-200 bg-rose-50/50'
								: 'border-amber-200 bg-amber-50/50'}"
						>
							<div class="flex items-start justify-between gap-3">
								<span class="text-sm font-semibold text-zinc-900"
									>{displayCategory(alert.category)}</span
								>
								<span
									class="shrink-0 text-sm font-semibold tabular-nums"
									class:text-rose-600={alert.status === 'over_budget'}
									class:text-amber-600={alert.status === 'near_limit'}
								>
									{delta.text}
								</span>
							</div>
							<p class="mt-1 text-xs text-zinc-500">
								{formatSpentOfLimit(alert.spentCents, alert.limitCents)}
								{#if alert.remainingDays !== null}
									· {alert.remainingDays !== 1
										? m.dashboard_insights_days_left_many({ count: alert.remainingDays })
										: m.dashboard_insights_days_left_one({ count: alert.remainingDays })}
									{#if alert.dailyPaceCents !== null}
										{m.dashboard_insights_daily_pace({ pace: formatCents(alert.dailyPaceCents) })}
									{/if}
								{/if}
							</p>
							<div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
								<div
									class="h-full rounded-full {widthClass(usagePercentage)}"
									class:bg-rose-500={alert.status === 'over_budget'}
									class:bg-amber-400={alert.status === 'near_limit'}
								></div>
							</div>
							<div class="mt-3 flex justify-end">
								<a
									class="rounded-full px-3 py-1.5 text-sm font-medium"
									class:bg-rose-100={alert.status === 'over_budget'}
									class:text-rose-700={alert.status === 'over_budget'}
									class:bg-amber-100={alert.status === 'near_limit'}
									class:text-amber-800={alert.status === 'near_limit'}
									href={categoryHref(alert.category)}
								>
									{m.dashboard_insights_view_category()}
								</a>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			{#if insights.unusualSpending || insights.uncategorizedCount > 0}
				<div
					class="mt-3 divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200"
				>
					{#if insights.unusualSpending}
						{@const spending = insights.unusualSpending}
						<div class="flex items-center gap-3 px-4 py-2.5">
							<svg
								class="h-4 w-4 shrink-0 text-zinc-400"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.7"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="m3 17 6-6 4 4 8-8" />
								<path d="M17 7h4v4" />
							</svg>
							<div class="min-w-0 flex-1 text-sm text-zinc-600">
								{m.dashboard_insights_unusual_spending({
									category: displayCategory(spending.category),
									percent: Math.round(spending.increasePercentage)
								})}
								<span class="text-zinc-400">
									{m.dashboard_insights_unusual_spending_detail({
										current: formatCents(spending.currentCents),
										average: formatCents(spending.averageCents)
									})}
								</span>
							</div>
							<a
								class="inline-flex shrink-0 items-center py-1 text-xs font-medium text-zinc-500 hover:text-zinc-700"
								href={categoryHref(spending.category)}
							>
								{m.dashboard_insights_view_category()}
							</a>
						</div>
					{/if}
					{#if insights.uncategorizedCount > 0}
						<div class="flex items-center gap-3 px-4 py-2.5">
							<svg
								class="h-4 w-4 shrink-0 text-zinc-400"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.7"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="M22 12h-6l-2 3h-4l-2-3H2" />
								<path
									d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"
								/>
							</svg>
							<div class="min-w-0 flex-1 text-sm text-zinc-600">
								<span class="font-medium text-zinc-900">
									{insights.uncategorizedCount !== 1
										? m.dashboard_insights_uncategorized_many({
												count: insights.uncategorizedCount
											})
										: m.dashboard_insights_uncategorized_one({
												count: insights.uncategorizedCount
											})}
								</span>
								<span class="text-zinc-400">{m.dashboard_insights_uncategorized_hint()}</span>
							</div>
							<a
								class="inline-flex shrink-0 items-center py-1 text-xs font-medium text-zinc-500 hover:text-zinc-700"
								href={resolve('/transactions?type=classify')}
							>
								{m.dashboard_insights_open_assistant()}
							</a>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</section>
{/if}

{#if aiHasContent}
	<section class={insightsHasContent ? 'mt-3' : 'mt-6'}>
		{#await aiAdvice}
			<div class="rounded-lg border border-dashed border-zinc-300 p-4">
				<div class="flex min-h-11 items-center gap-2">
					<span class="shrink-0">
						<Badge tone="neutral">{m.dashboard_insights_ai_badge()}</Badge>
					</span>
					<span class="min-w-0 flex-1 truncate text-sm text-zinc-500">
						{m.dashboard_insights_ai_pending()}
					</span>
				</div>
			</div>
		{:then resolved}
			{@const aiItems = (resolved?.insights ?? []).filter((item) => item.source === 'local-llm')}
			{@const showAiAdviceCard = aiItems.length > 0}
			{@const showAiUnavailableCard = resolved?.unavailable === true && !showAiAdviceCard}
			{#if showAiUnavailableCard}
				<div class="rounded-lg border border-dashed border-zinc-300 p-4">
					<button
						type="button"
						class="flex min-h-11 w-full items-center gap-2 text-left"
						onclick={() => (aiOpen = !aiOpen)}
						aria-expanded={aiOpen}
						aria-controls="dashboard-ai-unavailable-content"
					>
						<span class="shrink-0">
							<Badge tone="neutral">{m.dashboard_insights_ai_badge()}</Badge>
						</span>
						<span class="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900">
							{m.dashboard_insights_ai_unavailable_title()}
						</span>
						<svg
							class="ml-auto h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-150"
							class:rotate-180={aiOpen}
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
					<p
						id="dashboard-ai-unavailable-content"
						class="{aiOpen ? '' : 'hidden'} mt-1 text-xs text-zinc-500"
					>
						{m.dashboard_insights_ai_unavailable_message()}
						<a
							class="font-medium text-zinc-600 underline hover:text-zinc-800"
							href={resolve('/settings')}
						>
							{m.dashboard_insights_settings_link()}
						</a>.
					</p>
				</div>
			{/if}

			{#if showAiAdviceCard}
				<div class="rounded-lg bg-zinc-50 p-4">
					<!-- showAiUnavailableCard/showAiAdviceCard are mutually exclusive (see the
					     $const above), so sharing aiOpen across both cards never desyncs two
					     visible cards at once. -->
					<button
						type="button"
						class="flex min-h-11 w-full items-center gap-2 text-left"
						onclick={() => (aiOpen = !aiOpen)}
						aria-expanded={aiOpen}
						aria-controls="dashboard-ai-advice-content"
					>
						<span class="shrink-0">
							<Badge tone="neutral">{m.dashboard_insights_ai_badge()}</Badge>
						</span>
						<span class="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-900">
							{aiOpen ? m.dashboard_insights_ai_advice_title() : aiItems[0].title}
						</span>
						<svg
							class="ml-auto h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-150"
							class:rotate-180={aiOpen}
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
					<div id="dashboard-ai-advice-content" class="{aiOpen ? '' : 'hidden'} mt-2.5 space-y-2.5">
						{#each aiItems as item (item.id)}
							<div>
								<div class="text-sm font-medium text-zinc-900">{item.title}</div>
								<p class="text-xs text-zinc-600">{item.message}</p>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		{:catch}
			<!-- The server already converts a failed generation into `unavailable`, so this only
			     catches a caller handing us a rejecting promise. Same card either way. -->
			<div class="rounded-lg border border-dashed border-zinc-300 p-4">
				<div class="flex min-h-11 items-center gap-2">
					<span class="shrink-0">
						<Badge tone="neutral">{m.dashboard_insights_ai_badge()}</Badge>
					</span>
					<span class="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900">
						{m.dashboard_insights_ai_unavailable_title()}
					</span>
				</div>
			</div>
		{/await}
	</section>
{/if}
