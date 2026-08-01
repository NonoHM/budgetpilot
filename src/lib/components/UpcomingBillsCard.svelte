<script lang="ts">
	import Avatar from '$lib/components/Avatar.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import { formatCents } from '$lib/domain/budget';
	import { formatShortDate } from '$lib/domain/dateFormat';
	import { cardBase } from '$lib/styles';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { UpcomingBillsWidgetView } from '$lib/server/upcoming-bills/service';

	const MS_PER_DAY = 86_400_000;
	/** Rows past this index are hidden below `lg` — the widget always fetches at most 5, but the
	 *  mobile viewport only has room for 3 (locked design decision A2). */
	const MOBILE_ROW_LIMIT = 3;

	/**
	 * Dashboard sidebar widget for the "upcoming bills" feature (rolling 30-day horizon).
	 *
	 * `widget` is entirely pre-computed server-side by `loadUpcomingBillsWidget` — rows are already
	 * filtered (open occurrences only, uncertain tier excluded, capped at 5, date ascending) and
	 * `remainingExpenseCents` is already totalled over that same kept set. This component never
	 * re-filters or re-totals: doing so here would silently diverge from the server's total the
	 * moment the two lists disagree (e.g. a 6th kept occurrence that never reaches `rows`).
	 *
	 * The footer's "30 prochains jours" label is a locked product decision and always renders, on
	 * both breakpoints: the neighbouring cash-flow forecast card directly below this one uses a
	 * CALENDAR-MONTH horizon, and this widget uses a ROLLING 30-DAY one — the label is what keeps a
	 * reader from conflating the two totals.
	 */
	let { widget }: { widget: UpcomingBillsWidgetView } = $props();

	function toEpochDay(iso: string): number {
		return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
	}

	/** Whole days from today to `dateIso`, today's date computed at render time (UTC midnight, same
	 *  convention as the rest of the app's date-only fields). */
	function daysFromToday(dateIso: string): number {
		const todayIso = new Date().toISOString().slice(0, 10);
		return Math.round((toEpochDay(dateIso) - toEpochDay(todayIso)) / MS_PER_DAY);
	}

	function relativeDateLabel(dateIso: string): string {
		const delta = daysFromToday(dateIso);
		if (delta <= 0) return m.bills_date_today();
		if (delta === 1) return m.bills_date_tomorrow();
		return m.bills_date_in_days_short({ count: delta });
	}

	// Overdue rows are the only tinted ones in this widget: `bg-amber-50` on the row plus
	// `text-amber-700` on its sub-line, below. Locked contrast pair.
	// contrast 4.85:1, AA minimum 4.5:1. Do not modify #b45309 or #fffbeb without revalidating the ratio.
	const OVERDUE_ROW_CLASS = 'border-amber-200 bg-amber-50';
	const OVERDUE_TEXT_CLASS = 'text-amber-700';
</script>

<div class="{cardBase} p-5">
	<div class="flex items-baseline justify-between gap-2">
		<h2 class="text-sm font-semibold tracking-tight text-zinc-900">
			{m.dashboard_upcoming_title()}
		</h2>
		{#if widget.overdueCount > 0}
			<Badge tone="warning">
				{m.dashboard_upcoming_overdue_badge({ count: widget.overdueCount })}
			</Badge>
		{/if}
	</div>

	{#if !widget.hasStreams}
		<EmptyState
			class="mt-3"
			card={false}
			title={m.dashboard_upcoming_empty_title()}
			description={m.dashboard_upcoming_empty_description()}
			ctaLabel={m.dashboard_upcoming_empty_cta()}
			ctaHref="/upcoming-bills"
		/>
	{:else}
		<div class="mt-3 divide-y divide-zinc-100">
			{#each widget.rows as row, index (row.rowKey)}
				<div
					class="{index >= MOBILE_ROW_LIMIT
						? 'max-lg:hidden'
						: ''} flex items-center gap-3 rounded-xl py-3 first:pt-0 last:pb-0 {row.status ===
					'overdue'
						? `-mx-2 border px-2 ${OVERDUE_ROW_CLASS}`
						: ''}"
				>
					<Avatar initials={row.initials} size={32} />
					<div class="min-w-0 flex-1">
						<div class="truncate text-sm font-medium text-zinc-900">{row.label}</div>
						{#if row.status === 'overdue'}
							<div class="text-xs {OVERDUE_TEXT_CLASS}">
								{m.bills_date_expected({ date: formatShortDate(row.dateIso, getLocale()) })} ·
								{m.bills_date_late_short({ count: row.daysLate ?? 0 })}
							</div>
						{:else}
							<div class="text-xs text-zinc-400">{relativeDateLabel(row.dateIso)}</div>
						{/if}
					</div>
					{#if row.variability === 'variable'}
						<div class="shrink-0 text-right">
							<div
								class="text-sm font-semibold tabular-nums {row.amountCents >= 0
									? 'text-emerald-600'
									: 'text-zinc-900'}"
							>
								{m.bills_amount_range({
									min: formatCents(row.minAmountCents),
									max: formatCents(row.maxAmountCents)
								})}
							</div>
							<div class="text-[11px] text-zinc-400">{m.bills_amount_variable_tag()}</div>
						</div>
					{:else}
						<div
							class="shrink-0 text-sm font-semibold tabular-nums {row.amountCents >= 0
								? 'text-emerald-600'
								: 'text-zinc-900'}"
						>
							{row.amountCents >= 0 ? '+' : '−'}{formatCents(Math.abs(row.amountCents))}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	<!-- Footer always renders, on both breakpoints (locked decision): the neighbouring forecast
	     card uses a calendar-month horizon while this one is a rolling 30-day window, and this
	     label is what keeps the two totals from being read as the same thing. -->
	<div class="mt-4 flex items-center justify-between gap-3 border-t border-zinc-100 pt-3">
		<div class="min-w-0">
			<div class="text-xs font-semibold text-zinc-700">{m.dashboard_upcoming_footer_label()}</div>
			<div class="text-sm font-bold text-zinc-900 tabular-nums">
				{formatCents(-widget.remainingExpenseCents)}
			</div>
		</div>
		<TapLink href="/upcoming-bills">{m.dashboard_upcoming_view_all()}</TapLink>
	</div>
</div>
