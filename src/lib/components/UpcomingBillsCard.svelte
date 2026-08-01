<script lang="ts">
	import Avatar from '$lib/components/Avatar.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import { formatCents } from '$lib/domain/budget';
	import { formatShortDate } from '$lib/domain/dateFormat';
	import { formatAmountRangeBounds } from '$lib/domain/upcomingBills';
	import { cardBase } from '$lib/styles';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { UpcomingBillsWidgetView } from '$lib/server/upcoming-bills/service';

	const MS_PER_DAY = 86_400_000;
	/** Rows past this index are hidden below `lg` — the widget always fetches at most 5, but the
	 *  mobile viewport only has room for 3 (locked design decision A4, mobile). */
	const MOBILE_ROW_LIMIT = 3;
	/** At or under this many days out, the date is zinc-900 and the relative part bold zinc-700;
	 *  beyond it both drop to zinc-500/zinc-400 (design section D — proximity is carried by WEIGHT,
	 *  never by a new colour). */
	const NEAR_HORIZON_DAYS = 7;

	/**
	 * Dashboard sidebar widget for the "upcoming bills" feature (rolling 30-day horizon).
	 *
	 * `widget` is entirely pre-computed server-side by `loadUpcomingBillsWidget` — rows are already
	 * filtered (open occurrences only, uncertain tier excluded, capped at 5, date ascending) and
	 * `remainingExpenseCents` is already totalled over that same kept set. This component never
	 * re-filters or re-totals: doing so here would silently diverge from the server's total the
	 * moment the two lists disagree (e.g. a 6th kept occurrence that never reaches `rows`).
	 *
	 * The footer's "30 prochains jours" label is a locked product decision: whenever there is a
	 * total to show it renders in full, on both breakpoints — the neighbouring cash-flow forecast
	 * card directly below this one uses a CALENDAR-MONTH horizon, and this widget uses a ROLLING
	 * 30-DAY one, so the label is what keeps a reader from conflating the two totals. It is omitted
	 * only in the "nothing to show" empty state, where there is no total to confuse it with (design
	 * planche A3).
	 *
	 * `widget.todayIso` is the server's own UTC date (same field as `UpcomingBillsMonthView`). Every
	 * relative date below is computed against it, never against the browser clock: a client past
	 * 19:00 UTC-5 is already "tomorrow" in UTC while the server-computed row statuses still read
	 * today's date, and rendering off `new Date()` would print a sub-line that disagrees with them.
	 */
	let { widget }: { widget: UpcomingBillsWidgetView } = $props();

	function toEpochDay(iso: string): number {
		return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
	}

	/** Whole days from `widget.todayIso` (server-computed) to `dateIso`. */
	function daysUntil(dateIso: string): number {
		return Math.round((toEpochDay(dateIso) - toEpochDay(widget.todayIso)) / MS_PER_DAY);
	}

	function relativeDateLabel(delta: number): string {
		if (delta <= 0) return m.bills_date_today();
		if (delta === 1) return m.bills_date_tomorrow();
		return m.bills_date_in_days_short({ count: delta });
	}

	/**
	 * `minAmountCents`/`maxAmountCents` are UNSIGNED magnitudes (see `forecast.ts`), so the sign
	 * carrying the row's direction has to be applied here — the message key composes two already
	 * signed strings, it does not know the direction itself. Signed with the same '+'/'−' glyph as
	 * the fixed-amount branch below, rather than handing a negative number to `Intl` — its own
	 * negative-currency rendering uses a plain ASCII hyphen, a second minus glyph in one card.
	 * `formatAmountRangeBounds` also keeps the currency symbol to one occurrence ("−74 à −96 €") and
	 * is shared with the /upcoming-bills page so the two surfaces cannot drift apart.
	 */
	function formatSignedRange(row: UpcomingBillsWidgetView['rows'][number]): string {
		const sign = row.amountCents >= 0 ? '+' : '−';
		return m.bills_amount_range(
			formatAmountRangeBounds(row.minAmountCents, row.maxAmountCents, sign, getLocale())
		);
	}

	// Overdue rows are the only tinted ones in this widget: `bg-amber-50` on the row plus
	// `text-amber-700` on its sub-line, below. Locked contrast pair.
	// contrast 4.85:1, AA minimum 4.5:1. Do not modify #b45309 or #fffbeb without revalidating the ratio.
	const OVERDUE_ROW_CLASS = 'border-amber-200 bg-amber-50';
	const OVERDUE_TEXT_CLASS = 'text-amber-700';

	// `remainingExpenseCents` is unsigned (a sum of expense magnitudes); the footer always shows it
	// as an outflow. Prefixing the literal glyph — rather than formatting `-remainingExpenseCents` —
	// does two things at once: it keeps the same U+2212 glyph the row amounts use (Intl's own
	// negative-currency rendering doesn't necessarily match it), and it sidesteps `-0`: negating an
	// exact 0 produces negative zero, which `Intl.NumberFormat` renders as "-0,00 €" — reachable
	// whenever nothing is due in the window, verified by execution, not assumed.
	const remainingExpenseFormatted = $derived(
		widget.remainingExpenseCents === 0
			? formatCents(0)
			: `−${formatCents(widget.remainingExpenseCents)}`
	);
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
			<rect x="3.5" y="5" width="17" height="15" rx="2" />
			<path d="M8 3v4M16 3v4M3.5 10h17" />
		</svg>
	{/snippet}

	{#if !widget.hasStreams && widget.emptyState === 'all-stale'}
		<!-- Every stream survives exclusions but has gone quiet longer than one tolerated cycle
		     (task 2026-08-02, follow-up to #97): the "no flow ever detected" copy below and its
		     "Importer" CTA would both be false claims for a user who already has a cancelled
		     subscription on file.

		     DELIBERATELY its own copy, not `m.dashboard_forecast_stale_*` — the forecast card
		     directly below this one (`+page.svelte`) reaches `emptyState === 'all-stale'` under the
		     same condition whenever the stale stream is also reliable-confirmed, and the two cards
		     are adjacent siblings on the SAME page. Reusing "Récurrences en veille" there would stack
		     two empty cards with an identical title. This card names the consequence for upcoming
		     bills specifically ("plus d'échéance"); the forecast card owns "Récurrences en veille"
		     (see `page.svelte.spec.ts`, "renders two distinct all-stale empty cards, never the same
		     title twice"). -->
		<EmptyState
			class="mt-3"
			card={false}
			icon={emptyIcon}
			title={m.dashboard_upcoming_stale_title()}
			description={m.dashboard_upcoming_stale_description()}
		/>
	{:else if !widget.hasStreams}
		<!-- No recurring flow ever detected: EmptyState explains what the engine needs. -->
		<EmptyState
			class="mt-3"
			card={false}
			icon={emptyIcon}
			title={m.dashboard_upcoming_empty_title()}
			description={m.dashboard_upcoming_empty_description()}
			ctaLabel={m.dashboard_upcoming_empty_cta()}
			ctaHref="/upcoming-bills"
		/>
	{:else if widget.rows.length === 0}
		<!-- Streams ARE detected, but none survive into the window (all tentative, or all settled
		     inside it): a different empty state, careful not to assert "you owe nothing" when the
		     truth is "no rhythm confirmed for this window" (F5). -->
		<EmptyState
			class="mt-3"
			card={false}
			icon={emptyIcon}
			title={m.dashboard_upcoming_none_due_title()}
		/>
	{:else}
		<div class="mt-3 divide-y divide-zinc-100">
			{#each widget.rows as row, index (row.rowKey)}
				{@const delta = daysUntil(row.dateIso)}
				{@const near = delta <= NEAR_HORIZON_DAYS}
				<!-- `first:`/`last:` pseudo-classes match DOM position, not visibility, so they cannot
				     drive the padding here: rows past MOBILE_ROW_LIMIT stay in the DOM (just
				     `max-lg:hidden`), which would leave the actual last VISIBLE mobile row still
				     carrying its bottom padding. Computed explicitly from `index` instead. -->
				{@const isLastMobileVisible = index === Math.min(MOBILE_ROW_LIMIT, widget.rows.length) - 1}
				{@const isLastDesktopVisible = index === widget.rows.length - 1}
				<div
					class="{index >= MOBILE_ROW_LIMIT ? 'max-lg:hidden' : ''} flex items-center gap-3
						rounded-xl py-3 {index === 0 ? 'pt-0' : ''} {isLastDesktopVisible ? 'pb-0' : ''}
						{isLastMobileVisible ? 'max-lg:pb-0' : ''} {row.status === 'overdue'
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
						{:else if delta <= 0}
							<!-- Always "near": `delta <= 0` is inside `delta <= NEAR_HORIZON_DAYS`. -->
							<div class="text-xs font-bold text-zinc-700">
								{m.bills_date_today()}
							</div>
						{:else}
							<div class="text-xs">
								<span class={near ? 'text-zinc-900' : 'text-zinc-500'}
									>{formatShortDate(row.dateIso, getLocale())}</span
								>
								·
								<span class={near ? 'font-bold text-zinc-700' : 'text-zinc-400'}
									>{relativeDateLabel(delta)}</span
								>
							</div>
						{/if}
					</div>
					{#if row.variability === 'variable'}
						<div class="shrink-0 text-right">
							<div
								class="text-sm font-semibold tabular-nums {row.amountCents >= 0
									? 'text-emerald-600'
									: 'text-zinc-900'}"
							>
								{formatSignedRange(row)}
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

		<!-- Footer always renders when there is a total to show, on both breakpoints (locked
		     decision): the neighbouring forecast card uses a calendar-month horizon while this one is
		     a rolling 30-day window, and this label is what keeps the two totals from being read as
		     the same thing. -->
		<div class="mt-4 flex items-center justify-between gap-3 border-t border-zinc-100 pt-3">
			<div class="min-w-0">
				<div class="text-xs font-semibold text-zinc-700">{m.dashboard_upcoming_footer_label()}</div>
				<div class="text-sm font-bold text-zinc-900 tabular-nums">
					{remainingExpenseFormatted}
				</div>
			</div>
			<TapLink href="/upcoming-bills">{m.dashboard_upcoming_view_all()}</TapLink>
		</div>
	{/if}
</div>
