<script lang="ts">
	import { navigating } from '$app/state';
	import { resolve } from '$app/paths';
	import Avatar from '$lib/components/Avatar.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import { formatCents } from '$lib/domain/budget';
	import { formatMonthLabel, formatShortDate } from '$lib/domain/dateFormat';
	import { toBillRowDomKey } from '$lib/domain/upcomingBills';
	import { cardBase } from '$lib/styles';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { UpcomingBillRowView } from '$lib/server/upcoming-bills/service';
	import type { PageData } from './$types';

	let {
		/** Server-resolved month view. Rows already carry their status, tier, amounts and
		 *  `estimatePassed`, and the two period totals are already summed over them — this page
		 *  groups and renders, it never re-filters, re-totals or re-derives a status. */
		data
	}: { data: PageData } = $props();

	const MS_PER_DAY = 86_400_000;
	/** At or under this many days out, the date is zinc-900 and the relative part bold zinc-700;
	 *  beyond it both drop to zinc-500/zinc-400 (design section D — proximity is carried by WEIGHT,
	 *  never by a new colour). Doubles as the "Dans les 7 jours" boundary of a future period. */
	const NEAR_HORIZON_DAYS = 7;
	/** Rows of the settled group visible before the "show more" link (design planche B1). */
	const SETTLED_COLLAPSED_ROWS = 3;

	// The ONLY tinted row in the app. Locked pair, carried here as a constant so the two values
	// appear once.
	// contrast 4.85:1, AA minimum 4.5:1. Do not modify #b45309 or #fffbeb without revalidating the ratio.
	// `!` because the row shell is `cardBase`, which already sets `bg-white border-zinc-200`: two
	// utilities of the same property have equal specificity and STYLESHEET order decides, not the
	// order they appear in the class attribute — so an unmarked `bg-amber-50` here would be a
	// coin flip rather than an override.
	const OVERDUE_ROW_CLASS = '!border-amber-200 !bg-amber-50';
	const OVERDUE_TEXT_CLASS = 'text-amber-700';
	// A DIFFERENT, deliberately darker pair: the confidence badge sitting ON an overdue row, where
	// the row background is already #fffbeb. #92400e on #fef3c7 = 6.1:1 (design section D). Written
	// with `!` because it overrides a colour Badge itself sets; see Badge's `class` prop.
	const OVERDUE_TIER_BADGE_CLASS = '!border-amber-200 !bg-amber-100 !text-amber-800';
	/** Uncertain tier off an overdue row (design: "bordered en zinc-400"). */
	const UNCERTAIN_TIER_BADGE_CLASS = '!border-zinc-400 !text-zinc-400';

	/** Five desktop columns: stream · date · amount · status · actions. Shared by the header row and
	 *  every data row so the two cannot drift apart. */
	const DESKTOP_GRID = 'lg:grid lg:grid-cols-[minmax(0,1fr)_150px_170px_120px_56px] lg:gap-4';

	const bills = $derived(data.bills);
	const locale = $derived(getLocale());
	const monthLabel = $derived(formatMonthLabel(bills.month, locale));
	/** Month name alone ("août"), for the copy that reads "prévu en {month}". `formatMonthLabel`
	 *  includes the year, which those sentences do not want. */
	const monthName = $derived(
		new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(
			new Date(`${bills.month}-01T00:00:00.000Z`)
		)
	);

	// Real perceptible-delay site: changing period re-runs `load()` server-side. `navigating` is
	// only truthy for that client-side navigation, and is scoped to this route so moving to another
	// page of the app never shows the skeleton.
	const isNavigatingBills = $derived(navigating.to?.url.pathname === '/upcoming-bills');

	/**
	 * Design B4's disabled navigator is the "recent account, insufficient history" state: NO stream
	 * has ever been detected, so no other period could hold anything either.
	 *
	 * It is emphatically NOT "this month happens to be empty". A user whose only confirmed stream is
	 * a yearly bill has zero rows in eleven months out of twelve, and on the current month there is
	 * no "Revenir à ce mois" escape either (that link is gated on `!isCurrentMonth`) — so keying
	 * this off `rows.length` walls the page off entirely, with no way back. `streamCount` is the
	 * predicate that means what the design means.
	 */
	const noStreamsAtAll = $derived(bills.streamCount === 0);
	/** Streams exist, this particular period just holds none of them. */
	const nothingDueThisPeriod = $derived(!noStreamsAtAll && bills.rows.length === 0);

	let settledExpanded = $state(false);
	// Reset on every period change: the flag is about ONE month's settled group, and leaving it set
	// would land the next month pre-expanded with no visible control that says so.
	$effect(() => {
		void bills.month;
		settledExpanded = false;
	});

	function toEpochDay(iso: string): number {
		return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
	}

	/** Whole days from the SERVER's `todayIso` to `dateIso`. Never `new Date()`: a browser west of
	 *  Greenwich can already be on the next UTC day while the server-computed statuses are not. */
	function daysUntil(dateIso: string): number {
		return Math.round((toEpochDay(dateIso) - toEpochDay(bills.todayIso)) / MS_PER_DAY);
	}

	function shiftMonth(month: string, delta: number): string {
		const shifted = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + delta, 1));
		return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
	}

	function monthHref(month: string) {
		return `/upcoming-bills?month=${month}` as `/upcoming-bills?month=${string}`;
	}

	interface BillGroup {
		/** Suffix of the heading id the group's `aria-labelledby` points at. */
		id: string;
		heading: string;
		rows: UpcomingBillRowView[];
		/** Only the settled group collapses (design B1). */
		collapsible: boolean;
	}

	/**
	 * Grouping is the one derivation this page owns: statuses, amounts and totals all arrive
	 * resolved from the server. A current or past period groups by STATUS (overdue first, so the
	 * order carries the hierarchy); a future period groups by PROXIMITY instead, because on a month
	 * that has not started nothing can be overdue and "how soon" is the only question left.
	 * Ignored rows stay in their date group there, and join the settled group otherwise.
	 */
	const groups = $derived.by<BillGroup[]>(() => {
		const rows = bills.rows;

		if (bills.isFutureMonth) {
			const boundary = new Date(toEpochDay(bills.todayIso) + NEAR_HORIZON_DAYS * MS_PER_DAY)
				.toISOString()
				.slice(0, 10);
			const soon = rows.filter((row) => row.dateIso <= boundary);
			const later = rows.filter((row) => row.dateIso > boundary);

			return [
				{ id: 'soon', heading: m.bills_group_soon(), rows: soon, collapsible: false },
				{
					id: 'later',
					heading: m.bills_group_later({ month: monthName }),
					rows: later,
					collapsible: false
				}
			].filter((group) => group.rows.length > 0);
		}

		return [
			{
				id: 'overdue',
				heading: m.bills_group_overdue(),
				rows: rows.filter((row) => row.status === 'overdue'),
				collapsible: false
			},
			{
				id: 'upcoming',
				heading: m.bills_group_upcoming(),
				rows: rows.filter((row) => row.status === 'upcoming'),
				collapsible: false
			},
			{
				id: 'settled',
				heading: m.bills_group_settled(),
				rows: rows.filter((row) => row.status === 'settled' || row.status === 'ignored'),
				collapsible: true
			}
		].filter((group) => group.rows.length > 0);
	});

	function visibleRows(group: BillGroup): UpcomingBillRowView[] {
		if (!group.collapsible || settledExpanded) return group.rows;
		return group.rows.slice(0, SETTLED_COLLAPSED_ROWS);
	}

	function tierLabel(row: UpcomingBillRowView): string {
		if (row.tier === 'confirmed') return m.bills_tier_confirmed();
		if (row.tier === 'likely') return m.bills_tier_likely();
		return m.bills_tier_uncertain();
	}

	/**
	 * `row.status` is rendered as given. An uncertain-tier row is already `'upcoming'` with a null
	 * `daysLate` whatever its estimated date — the domain gates on the tier BEFORE any date
	 * arithmetic — so there is deliberately no lateness test anywhere in this component.
	 */
	function statusLabel(row: UpcomingBillRowView): string {
		if (row.status === 'overdue') return m.bills_status_overdue();
		if (row.status === 'ignored') return m.bills_status_ignored();
		if (row.status === 'settled') {
			return row.direction === 'income' ? m.bills_status_received() : m.bills_status_paid();
		}
		return m.bills_status_upcoming();
	}

	function cadenceLabel(row: UpcomingBillRowView): string {
		if (row.cadence === 'weekly') return m.bills_cadence_weekly();
		if (row.cadence === 'biweekly') return m.bills_cadence_biweekly();
		if (row.cadence === 'quarterly') return m.bills_cadence_quarterly({ day: row.anchorDayOfMonth });
		if (row.cadence === 'yearly') return m.bills_cadence_yearly();
		return m.bills_cadence_monthly({ day: row.anchorDayOfMonth });
	}

	function kindLabel(row: UpcomingBillRowView): string {
		return row.direction === 'income' ? m.bills_kind_credit() : m.bills_kind_debit();
	}

	/** Whole-euro formatting of an unsigned magnitude: the observed bounds of a variable stream are
	 *  rounded to the euro, since a `,00 €` there would assert a precision that does not exist. */
	function formatWholeEuros(magnitudeCents: number): string {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency: 'EUR',
			maximumFractionDigits: 0
		}).format(magnitudeCents / 100);
	}

	/** `minAmountCents`/`maxAmountCents` are UNSIGNED magnitudes, so the direction's sign is applied
	 *  here with the same U+2212 glyph the fixed branch uses — Intl's own negative-currency output
	 *  is an ASCII hyphen, which would put two different minus glyphs in one list. */
	function amountText(row: UpcomingBillRowView): string {
		const sign = row.amountCents >= 0 ? '+' : '−';
		if (row.variability === 'variable') {
			return m.bills_amount_range({
				min: `${sign}${formatWholeEuros(row.minAmountCents)}`,
				max: `${sign}${formatWholeEuros(row.maxAmountCents)}`
			});
		}
		return `${sign}${formatCents(Math.abs(row.amountCents))}`;
	}

	/** `remainingExpenseCents` is an unsigned sum of expense magnitudes, shown as an outflow. The
	 *  zero case is guarded rather than negated: `-0` exists, and `Intl` renders it "-0,00 €" —
	 *  reachable on any future month with no expense due. Same guard as the dashboard widget. */
	function signedOutflow(magnitudeCents: number): string {
		return magnitudeCents === 0 ? formatCents(0) : `−${formatCents(magnitudeCents)}`;
	}

	function variabilityLabel(row: UpcomingBillRowView): string {
		return row.variability === 'variable'
			? m.bills_amount_variable_avg({ amount: formatCents(row.averageAmountCents) })
			: m.bills_amount_fixed();
	}

	/** Sub-line under the amount. The uncertain tier appends "hors total" because it is the one
	 *  tier the period totals leave out, and a figure the user reads as a balance has to say so. */
	function amountNote(row: UpcomingBillRowView): string {
		const base = variabilityLabel(row);
		return row.tier === 'uncertain' ? `${base} · ${m.bills_amount_excluded()}` : base;
	}

	function notCountedLabel(): string {
		return bills.isCurrentMonth
			? m.bills_not_counted()
			: m.bills_not_counted_future({ month: monthName });
	}

	/**
	 * The line under the date. `row.daysLate` and `row.estimatePassed` are both read as given:
	 * "date estimée dépassée" is a date-passed DISPLAY flag on an uncertain row, not a lateness
	 * computation, and the two can never both be set.
	 */
	function relativeDateLabel(row: UpcomingBillRowView): string | null {
		if (row.status === 'overdue') return m.bills_date_late_short({ count: row.daysLate ?? 0 });
		if (row.status === 'settled' || row.status === 'ignored') return null;
		if (row.estimatePassed) return m.bills_date_estimate_passed();

		const delta = daysUntil(row.dateIso);
		if (delta <= 0) return m.bills_date_today();
		if (delta === 1) return m.bills_date_tomorrow();
		return m.bills_date_in_days_full({ count: delta });
	}

	/** Mobile condenses date + variability + category into one sub-line (design planche C1). */
	function mobileSubLine(row: UpcomingBillRowView): string {
		const shortDate = formatShortDate(row.dateIso, locale);

		if (row.status === 'ignored') return `${shortDate} · ${notCountedLabel()}`;
		if (row.status === 'settled') return `${variabilityLabel(row)} · ${row.category}`;

		const datePart = row.estimatePassed
			? m.bills_date_passed_short({ date: shortDate })
			: daysUntil(row.dateIso) <= 0 && row.status === 'upcoming'
				? m.bills_date_today()
				: shortDate;
		const tail = row.tier === 'uncertain' ? m.bills_amount_excluded() : row.category;
		return `${datePart} · ${variabilityLabel(row)} · ${tail}`;
	}
</script>

<svelte:head>
	<title>{m.bills_page_title()}</title>
</svelte:head>

{#snippet chevronIcon(path: string)}
	<svg
		class="h-4 w-4"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="1.75"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<path d={path} />
	</svg>
{/snippet}

{#snippet tierBadge(row: UpcomingBillRowView)}
	{#if row.tier === 'uncertain'}
		<Tooltip label={m.bills_tier_uncertain_tooltip({ count: row.occurrenceCount })}>
			<Badge
				tone="neutral"
				shape="rounded"
				bordered
				class={row.status === 'overdue' ? OVERDUE_TIER_BADGE_CLASS : UNCERTAIN_TIER_BADGE_CLASS}
			>
				{tierLabel(row)}
			</Badge>
		</Tooltip>
	{:else}
		<Badge
			tone="neutral"
			shape="rounded"
			bordered={row.tier === 'likely'}
			class={row.status === 'overdue' ? OVERDUE_TIER_BADGE_CLASS : ''}
		>
			{tierLabel(row)}
		</Badge>
	{/if}
{/snippet}

{#snippet statusBadge(row: UpcomingBillRowView, withDays: boolean)}
	{#if row.status === 'overdue'}
		<Badge tone="warning">
			{withDays
				? m.bills_status_overdue_days({ count: row.daysLate ?? 0 })
				: m.bills_status_overdue()}
		</Badge>
	{:else if row.status === 'settled'}
		<Badge tone="success">{statusLabel(row)}</Badge>
	{:else}
		<Badge tone="neutral" bordered>{statusLabel(row)}</Badge>
	{/if}
{/snippet}

{#snippet amountBlock(row: UpcomingBillRowView)}
	<div
		class="text-sm font-semibold tabular-nums {row.status === 'ignored'
			? 'text-zinc-400 line-through'
			: row.status === 'settled'
				? 'text-zinc-500'
				: row.amountCents >= 0
					? 'text-emerald-600'
					: 'text-zinc-900'}"
	>
		{amountText(row)}
	</div>
	<div class="text-[11px] {row.status === 'ignored' ? 'text-zinc-400' : 'text-zinc-500'}">
		{row.status === 'ignored' ? notCountedLabel() : amountNote(row)}
	</div>
{/snippet}

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

{#snippet observationDetail()}
	<div class="text-left">
		<div class="text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">
			{m.bills_empty_observing()}
		</div>
		<ul class="mt-2 space-y-1.5">
			<!-- Keyed by index, not by label: two candidates can legitimately carry the same
			     anonymized label (two amount groups of one merchant), and a duplicate key throws. -->
			{#each bills.observationCandidates as candidate, index (index)}
				<li class="flex items-baseline justify-between gap-3 text-[13px]">
					<span class="truncate text-zinc-700">{candidate.label}</span>
					<span class="shrink-0 text-zinc-400">
						<span class="hidden lg:inline"
							>{candidate.occurrenceCount === 1
								? m.bills_empty_progress_one({ count: candidate.occurrenceCount })
								: m.bills_empty_progress_many({ count: candidate.occurrenceCount })}</span
						>
						<span class="lg:hidden"
							>{m.bills_empty_progress_short({ count: candidate.occurrenceCount })}</span
						>
					</span>
				</li>
			{/each}
		</ul>
	</div>
{/snippet}

<main class="min-h-screen bg-zinc-50 px-4 py-8 text-zinc-950 sm:px-6 lg:px-8">
	<section class="mx-auto max-w-5xl space-y-6">
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h1 class="text-xl font-bold tracking-tight text-zinc-900">{m.bills_title()}</h1>
				<!-- Desktop states the stream count and both period totals; mobile keeps only the figure
				     the user acts on (design planche C1). -->
				<p class="mt-1 hidden text-sm text-zinc-500 lg:block">
					{#if bills.isCurrentMonth}
						{m.bills_header_meta_current({
							count: bills.streamCount,
							amount: formatCents(bills.remainingExpenseCents)
						})}
					{:else}
						{m.bills_header_meta_future({
							count: bills.streamCount,
							month: monthName,
							expense: signedOutflow(bills.remainingExpenseCents),
							income: `+${formatCents(bills.expectedIncomeCents)}`
						})}
					{/if}
				</p>
				<p class="mt-1 text-sm text-zinc-500 lg:hidden">
					{m.bills_header_meta_short({ amount: formatCents(bills.remainingExpenseCents) })}
				</p>
			</div>
			{#if !bills.isCurrentMonth}
				<TapLink href={resolve('/upcoming-bills')}>{m.bills_back_to_current()}</TapLink>
			{/if}
		</header>

		{#if noStreamsAtAll}
			<!-- Design B4 orders the page title, this headline, then the navigator, then the card. -->
			<p class="text-sm font-semibold text-zinc-700">{m.bills_empty_headline()}</p>
		{/if}

		<!-- Period navigator. The two controls are anchors, not buttons: changing period is real
		     navigation (`?month=`), so it must survive a middle-click and work without JS. They carry
		     the explicit aria-labels the design asks of them, and go inert the same way TapLink does
		     (no href, aria-disabled, out of the tab order) when NO stream has ever been detected —
		     see `noStreamsAtAll` for why that, and not an empty month, is the condition. -->
		<div class="flex items-center gap-2">
			<a
				href={noStreamsAtAll ? undefined : resolve(monthHref(shiftMonth(bills.month, -1)))}
				aria-label={m.bills_period_prev_aria()}
				aria-disabled={noStreamsAtAll ? 'true' : undefined}
				tabindex={noStreamsAtAll ? -1 : undefined}
				class="inline-flex h-11 w-11 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none {noStreamsAtAll
					? 'pointer-events-none opacity-40'
					: ''}"
			>
				{@render chevronIcon('M14.5 5 8 12l6.5 7')}
			</a>
			<!-- Announced politely so a period change is spoken without pulling focus off the control
			     that caused it. -->
			<span aria-live="polite" class="text-sm font-semibold text-zinc-900 first-letter:uppercase">
				{monthLabel}
			</span>
			{#if bills.isCurrentMonth}
				<Badge tone="neutral">{m.bills_period_current_badge()}</Badge>
			{/if}
			<a
				href={noStreamsAtAll ? undefined : resolve(monthHref(shiftMonth(bills.month, 1)))}
				aria-label={m.bills_period_next_aria()}
				aria-disabled={noStreamsAtAll ? 'true' : undefined}
				tabindex={noStreamsAtAll ? -1 : undefined}
				class="inline-flex h-11 w-11 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none {noStreamsAtAll
					? 'pointer-events-none opacity-40'
					: ''}"
			>
				{@render chevronIcon('M9.5 5 16 12l-6.5 7')}
			</a>
		</div>

		<!-- The list region Task 8 moves focus back to after a row mutation. -->
		<div id="bills-list" tabindex="-1" class="space-y-6 outline-none">
			{#if isNavigatingBills || bills.rows.length > 0}
				<!-- Desktop column headers, outside the groups so they are not read as a list item, and
				     outside the loading branch because design B3 keeps them REAL while the rows pulse:
				     they are static copy and do not depend on the data being fetched. Group headings do
				     depend on it, which is why they are not scaffolded during a load. -->
				<div
					class="hidden px-4 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase {DESKTOP_GRID}"
					aria-hidden="true"
				>
					<span>{m.bills_col_stream()}</span>
					<span>{m.bills_col_date()}</span>
					<span>{m.bills_col_amount()}</span>
					<span>{m.bills_col_status()}</span>
					<span></span>
				</div>
			{/if}

			{#if isNavigatingBills}
				<!-- Title, column headers and the period arrows are already real; only what comes from
				     the engine pulses. Skeleton's own CSS freezes the pulse under
				     prefers-reduced-motion. -->
				<div class="space-y-3" role="status" aria-live="polite">
					<span class="sr-only">{m.bills_loading_aria()}</span>
					{#each { length: 3 } as _, index (index)}
						<Skeleton />
					{/each}
				</div>
			{:else if noStreamsAtAll}
				<!-- Nothing has ever been detected: the engine is still observing, and the counters show
				     what it has already seen. -->
				<EmptyState
					icon={emptyIcon}
					title={m.bills_empty_title()}
					description={m.bills_empty_description()}
					detail={bills.observationCandidates.length > 0 ? observationDetail : undefined}
					ctaLabel={m.bills_empty_cta()}
					ctaHref={resolve('/imports')}
				/>
			{:else if nothingDueThisPeriod}
				<!-- Streams ARE detected, this period just holds none of them. A separate state on
				     purpose (same fix as UpcomingBillsCard's): the observing copy would claim nothing
				     had been found, and its detail block would be empty anyway — the server only fills
				     `observationCandidates` when there are no rows AND no detected flow to attribute
				     them to. -->
				<EmptyState
					icon={emptyIcon}
					title={m.bills_none_due_title({ month: monthName })}
					description={m.bills_none_due_description()}
				/>
			{:else}
				{#each groups as group (group.id)}
					<section class="space-y-2">
						<h2 id="bills-group-{group.id}" class="text-sm font-semibold text-zinc-700">
							{m.bills_group_count({ heading: group.heading, count: group.rows.length })}
						</h2>
						<!-- Introduces role="list" in this codebase: the group heading names the list, and
						     every row is a direct role="listitem" child, so the read structure matches the
						     seen one. -->
						<div role="list" aria-labelledby="bills-group-{group.id}" class="space-y-2">
							{#each visibleRows(group) as row (row.rowKey)}
								{@const relative = relativeDateLabel(row)}
								<!-- A rowKey carries colons AND spaces (see toBillRowDomKey); neither is usable
								     in an id that aria-* attributes have to resolve. Task 8 must build its
								     focus target with the SAME helper. -->
								{@const domKey = toBillRowDomKey(row.rowKey)}
								{@const near = daysUntil(row.dateIso) <= NEAR_HORIZON_DAYS}
								<div
									role="listitem"
									id="bill-row-{domKey}"
									tabindex="-1"
									class="{cardBase} outline-none {row.status === 'overdue' ? OVERDUE_ROW_CLASS : ''}"
								>
									<!-- Desktop: the five fixed columns. -->
									<div class="hidden items-center px-4 py-3 {DESKTOP_GRID}">
										<div class="flex min-w-0 items-center gap-3">
											<Avatar initials={row.initials} size={32} />
											<div class="min-w-0">
												<div class="flex min-w-0 items-center gap-2">
													<span
														class="truncate text-sm font-medium {row.status === 'ignored'
															? 'text-zinc-400'
															: row.status === 'settled'
																? 'text-zinc-500'
																: 'text-zinc-900'}">{row.label}</span
													>
													{@render tierBadge(row)}
												</div>
												<div
													class="truncate text-xs {row.status === 'ignored'
														? 'text-zinc-400'
														: 'text-zinc-500'}"
												>
													{kindLabel(row)} · {cadenceLabel(row)} · {row.category}
												</div>
											</div>
										</div>
										<div class="min-w-0">
											<div
												class="text-sm {row.status === 'ignored'
													? 'text-zinc-400 line-through'
													: near
														? 'text-zinc-900'
														: 'text-zinc-500'}"
											>
												{formatShortDate(row.dateIso, locale)}
											</div>
											{#if relative}
												<!-- Lateness is written in words here as well as in the badge: no status is
												     ever carried by the amber tint alone. -->
												<div
													class="text-xs {row.status === 'overdue'
														? OVERDUE_TEXT_CLASS
														: near
															? 'font-bold text-zinc-700'
															: 'text-zinc-400'}"
												>
													{relative}
												</div>
											{/if}
										</div>
										<div class="min-w-0">{@render amountBlock(row)}</div>
										<div>{@render statusBadge(row, false)}</div>
										<div class="flex justify-end">
											{#if row.status === 'upcoming' || row.status === 'overdue'}
												<!-- Task 8 wires this trigger to the row action menu. Rendered disabled on
												     purpose here so it is not an interactive control that silently does
												     nothing. -->
												<IconButton label={m.bills_row_actions_aria()} disabled>
													<svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
														<circle cx="5" cy="12" r="1.6" />
														<circle cx="12" cy="12" r="1.6" />
														<circle cx="19" cy="12" r="1.6" />
													</svg>
												</IconButton>
											{/if}
										</div>
									</div>

									<!-- Mobile: two lines plus a right-hand stack of badges. One focusable control per
									     row, which Task 8 opens the action sheet from; inert here (aria-disabled rather
									     than the native attribute, so the row's own content stays readable). -->
									<button
										type="button"
										aria-disabled="true"
										class="flex w-full items-start gap-3 px-4 py-3 text-left focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none lg:hidden"
									>
										<Avatar initials={row.initials} size={32} />
										<div class="min-w-0 flex-1">
											<div class="flex items-baseline justify-between gap-2">
												<span
													class="truncate text-sm font-medium {row.status === 'ignored'
														? 'text-zinc-400'
														: row.status === 'settled'
															? 'text-zinc-500'
															: 'text-zinc-900'}">{row.label}</span
												>
												<span
													class="shrink-0 text-sm font-semibold tabular-nums {row.status === 'ignored'
														? 'text-zinc-400 line-through'
														: row.status === 'settled'
															? 'text-zinc-500'
															: row.amountCents >= 0
																? 'text-emerald-600'
																: 'text-zinc-900'}">{amountText(row)}</span
												>
											</div>
											<div
												class="mt-0.5 truncate text-xs {row.status === 'overdue'
													? OVERDUE_TEXT_CLASS
													: 'text-zinc-500'}"
											>
												{mobileSubLine(row)}
											</div>
										</div>
										<div class="flex shrink-0 flex-col items-end gap-1">
											{@render statusBadge(row, true)}
											{@render tierBadge(row)}
										</div>
									</button>

									{#if row.status === 'ignored'}
										<!-- Rendered once per row (not per breakpoint) so the id Task 8 focuses is
										     unique. Disabled until Task 8 wires the restore action. -->
										<div class="flex px-4 pb-2 lg:justify-end">
											<TapLink id="bill-restore-{domKey}" disabled>
												{m.bills_restore()}
											</TapLink>
										</div>
									{/if}
								</div>
							{/each}
						</div>

						{#if group.collapsible && !settledExpanded && group.rows.length > SETTLED_COLLAPSED_ROWS}
							<TapLink onclick={() => (settledExpanded = true)}>
								{@const hiddenCount = group.rows.length - SETTLED_COLLAPSED_ROWS}
							{hiddenCount === 1
								? m.bills_settled_show_more_one({ count: hiddenCount })
								: m.bills_settled_show_more_many({ count: hiddenCount })}
							</TapLink>
						{/if}
					</section>
				{/each}
			{/if}
		</div>
	</section>
</main>
