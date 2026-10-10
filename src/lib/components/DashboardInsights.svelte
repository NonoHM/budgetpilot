<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { formatCents, formatBudgetDelta, formatSpentOfLimit } from '$lib/domain/budget';
	import { widthClass } from '$lib/domain/widthClass';
	import { categoryDisplayName } from '$lib/domain/categoryLabels';
	import type { DashboardInsights } from '$lib/server/dashboard/insights';
	import type { LocalLlmFailureCode } from '$lib/domain/failureCodes';
	import type { LocalAiAdvice } from '$lib/server/insights/types';
	import Badge from '$lib/components/ui/Badge.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import * as m from '$lib/paraglide/messages';

	let {
		insights,
		aiAllowed,
		aiAdviceKey,
		periodQuery,
		onStale
	}: {
		insights: DashboardInsights;
		aiAllowed: boolean;
		/** Changes exactly when the advice would (#535); `null` when it cannot be prepared. */
		aiAdviceKey: string | null;
		/** The period on screen, in the canonical form the advice endpoint accepts. */
		periodQuery: string;
		/** The server no longer computes `aiAdviceKey` for this period: the page reloads its data. */
		onStale: () => void;
	} = $props();

	const insightsHasContent = $derived(
		insights.alerts.length > 0 ||
			insights.unusualSpending !== null ||
			insights.uncategorizedCount > 0
	);
	// The AI card renders whenever the feature is on and the advice can be prepared: closed, it is the
	// action that asks for advice. Without a key there is nothing it could ask for.
	const aiHasContent = $derived(aiAllowed && aiAdviceKey !== null);
	const totalAlertCount = $derived(insights.alerts.length + insights.alertOverflowCount);
	const worstAlertStatus = $derived(
		insights.alerts.some((alert) => alert.status === 'over_budget') ? 'over_budget' : 'near_limit'
	);

	// Collapsed by default on every breakpoint — identical mobile/desktop behavior.
	let insightsOpen = $state(false);
	let aiOpen = $state(false);

	/**
	 * THE CARD ASKS FOR ADVICE (#535). The dashboard load used to start a generation on every visit,
	 * hover prefetches included; now nothing is generated until the member opens this card, which is
	 * what the comparable products with an assistant do (Monarch, Copilot Money: a panel the user
	 * opens). A period change aborts what is in flight and returns the card to idle, closed: nothing
	 * is asked until the member presses again, so a month passed through never spends one of the
	 * hourly analyses (owner's ruling, 2026-10-10). The server keeps twelve answers per member, so a
	 * period already seen comes back at once, without generating or counting against the limit.
	 *
	 * `outcome` belongs to `askedKey` and to nothing else: a new key clears it AT ONCE (rev 1 F4: the
	 * previous period's advice must never sit beside the new period's figures), and an answer that
	 * arrives after its request was aborted is dropped.
	 */
	let askedKey = $state<string | null>(null);
	let outcome = $state<LocalAiAdvice | 'pending' | null>(null);
	let inFlight: AbortController | null = null;
	const resolved = $derived<LocalAiAdvice | null>(outcome === 'pending' ? null : outcome);
	const aiItems = $derived(
		(resolved?.insights ?? []).filter((item) => item.source === 'local-llm')
	);
	const showAiAdviceCard = $derived(aiItems.length > 0);
	// Advice wins over a contradictory `unavailable`, so the two cards are never both shown.
	const showAiUnavailableCard = $derived(resolved?.unavailable === true && !showAiAdviceCard);
	// `unreachable` when the server set no code: the honest reading of a run that produced nothing
	// without saying why.
	const aiFailureCode = $derived(resolved?.failureCode ?? 'unreachable');

	function cancelAsk() {
		inFlight?.abort();
		inFlight = null;
	}

	async function ask(key: string) {
		cancelAsk();
		askedKey = key;
		outcome = 'pending';
		const controller = new AbortController();
		inFlight = controller;
		const answer = await fetchAdvice(periodQuery, key, controller.signal);
		if (controller.signal.aborted) return;
		inFlight = null;
		if (answer === 'stale' || answer === null || answer.cancelled) {
			// Idle and closed, so the next press opens AND asks (narrow pass F3). A stale key means
			// the figures on screen are not the ones the server would advise on any more: the page
			// reloads them, and the member asks again with the new key.
			askedKey = null;
			outcome = null;
			aiOpen = false;
			if (answer === 'stale') onStale();
			return;
		}
		outcome = answer;
	}

	/** `null` for anything that is not the endpoint's JSON: an aborted request, a redirect to the
	 *  sign-in page, a 500. The card then offers the action again rather than inventing a failure the
	 *  server never named. `stale` when the server refused the key (409). */
	async function fetchAdvice(
		period: string,
		aiAdviceKey: string,
		signal: AbortSignal
	): Promise<LocalAiAdvice | 'stale' | null> {
		try {
			const response = await fetch('/insights/advice', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ period, aiAdviceKey }),
				signal
			});
			if (response.status === 409) return 'stale';
			if (!response.ok) return null;
			const body: unknown = await response.json();
			return typeof body === 'object' && body !== null && 'unavailable' in body
				? (body as LocalAiAdvice)
				: null;
		} catch {
			return null;
		}
	}

	function toggleAi() {
		aiOpen = !aiOpen;
		// Opening asks when nothing usable is held for this key: never asked, or a refusal or failure
		// the member may now retry. A held advice is shown as it is.
		const held = outcome !== null && outcome !== 'pending' && !outcome.unavailable;
		if (
			aiOpen &&
			aiAdviceKey !== null &&
			!(askedKey === aiAdviceKey && (held || outcome === 'pending'))
		) {
			void ask(aiAdviceKey);
		}
	}

	$effect(() => {
		const key = aiAdviceKey;
		untrack(() => {
			if (key === askedKey) return;
			cancelAsk();
			askedKey = null;
			outcome = null;
			aiOpen = false;
		});
	});

	$effect(() => cancelAsk);

	/**
	 * WHICH of the five ways the local model can produce nothing (#524), as a sentence.
	 *
	 * `Record<LocalLlmFailureCode, ...>` rather than a switch with a default, and that is the whole
	 * point of the shape: adding a code to the union without adding its sentence here stops
	 * `npm run check` rather than rendering a blank card. A default branch would have accepted the
	 * new code silently, which is the failure this card already had once.
	 *
	 * The sentences are built HERE and not on the server. `$lib/paraglide/messages` has no
	 * negotiated locale outside a request, so a server-built string is built in the wrong language
	 * (CLAUDE.md records what that cost in `domain/money.ts`). The server names the state; the
	 * interface owns the words.
	 */
	function aiFailureTitle(code: LocalLlmFailureCode): string {
		const titles: Record<LocalLlmFailureCode, string> = {
			cold_start: m.dashboard_insights_ai_cold_start_title(),
			unreachable: m.dashboard_insights_ai_unreachable_title(),
			not_configured: m.dashboard_insights_ai_not_configured_title(),
			model_unavailable: m.dashboard_insights_ai_model_unavailable_title(),
			response_unusable: m.dashboard_insights_ai_response_unusable_title(),
			response_truncated: m.dashboard_insights_ai_response_truncated_title(),
			busy: m.dashboard_insights_ai_busy_title(),
			quota_reached: m.dashboard_insights_ai_quota_reached_title()
		};
		return titles[code];
	}

	function aiFailureReason(code: LocalLlmFailureCode, retryInMinutes = 1): string {
		const reasons: Record<LocalLlmFailureCode, string> = {
			cold_start: m.dashboard_insights_ai_cold_start_message(),
			unreachable: m.dashboard_insights_ai_unreachable_reason(),
			not_configured: m.dashboard_insights_ai_not_configured_reason(),
			model_unavailable: m.dashboard_insights_ai_model_unavailable_reason(),
			response_unusable: m.dashboard_insights_ai_response_unusable_reason(),
			response_truncated: m.dashboard_insights_ai_response_truncated_reason(),
			busy: m.dashboard_insights_ai_busy_reason(),
			quota_reached: m.dashboard_insights_ai_quota_reached_reason({ minutes: retryInMinutes })
		};
		return reasons[code];
	}

	/**
	 * Whether to append « Check the configuration in [settings] ».
	 *
	 * False for `cold_start`, and that false is the defect this card was filed for: a model still
	 * loading is a state where there is nothing to configure, and sending the reader to a settings
	 * page implies the opposite. Its own sentence tells them to reopen the card instead, which asks
	 * again. False for `busy` and `quota_reached` too (#535): the model is fine, and so is the
	 * configuration; the reader waits.
	 */
	function aiFailureShowsConfigurationLink(code: LocalLlmFailureCode): boolean {
		const showsLink: Record<LocalLlmFailureCode, boolean> = {
			cold_start: false,
			unreachable: true,
			not_configured: true,
			model_unavailable: true,
			response_unusable: true,
			response_truncated: true,
			busy: false,
			quota_reached: false
		};
		return showsLink[code];
	}

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
									>{categoryDisplayName(alert.category)}</span
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
									category: categoryDisplayName(spending.category),
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
		<!-- One live region for the three faces of the card, so the outcome of an ask is announced
		     wherever it lands. -->
		<div aria-live="polite">
			{#if showAiUnavailableCard}
				<div class="rounded-lg border border-dashed border-zinc-300 p-4">
					<button
						type="button"
						class="flex min-h-11 w-full items-center gap-2 text-left"
						onclick={toggleAi}
						aria-expanded={aiOpen}
						aria-controls="dashboard-ai-unavailable-content"
					>
						<span class="shrink-0">
							<Badge tone="neutral">{m.dashboard_insights_ai_badge()}</Badge>
						</span>
						<span class="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900">
							{aiFailureTitle(aiFailureCode)}
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
						{aiFailureReason(aiFailureCode, resolved?.retryInMinutes)}
						{#if aiFailureShowsConfigurationLink(aiFailureCode)}
							{m.dashboard_insights_ai_check_configuration()}
							<a
								class="font-medium text-zinc-600 underline hover:text-zinc-800"
								href={resolve('/settings')}
							>
								{m.dashboard_insights_settings_link()}
							</a>.
						{/if}
					</p>
				</div>
			{:else if showAiAdviceCard}
				<div class="rounded-lg bg-zinc-50 p-4">
					<!-- showAiUnavailableCard/showAiAdviceCard are mutually exclusive (see their
					     $derived above), so sharing aiOpen across both cards never desyncs two
					     visible cards at once. -->
					<button
						type="button"
						class="flex min-h-11 w-full items-center gap-2 text-left"
						onclick={toggleAi}
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
			{:else}
				<!-- Idle or pending: the header IS the action that asks for advice (#535). Solid, with a
				     hover tint and the same chevron as every other disclosure on the dashboard, because
				     a dashed outline reads as an empty slot rather than as something to press. -->
				<div class="rounded-lg border border-zinc-200 bg-white transition-colors hover:bg-zinc-50">
					<button
						type="button"
						class="flex min-h-11 w-full items-center gap-2 p-4 text-left"
						onclick={toggleAi}
						aria-expanded={aiOpen}
						aria-busy={outcome === 'pending'}
					>
						<span class="shrink-0">
							<Badge tone="neutral">{m.dashboard_insights_ai_badge()}</Badge>
						</span>
						{#if outcome === 'pending'}
							<span class="min-w-0 flex-1 truncate text-sm text-zinc-500">
								{m.dashboard_insights_ai_pending()}
							</span>
						{:else if resolved}
							<!-- The model answered and had nothing to point out. -->
							<span class="min-w-0 flex-1 truncate text-sm text-zinc-500">
								{m.dashboard_insights_ai_empty()}
							</span>
						{:else}
							<span class="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900">
								{m.dashboard_insights_ai_idle()}
							</span>
						{/if}
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
				</div>
			{/if}
		</div>
	</section>
{/if}
