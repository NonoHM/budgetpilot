<script lang="ts">
	import { tick } from 'svelte';
	import { DropdownMenu } from 'bits-ui';
	import { enhance } from '$app/forms';
	import { navigating } from '$app/state';
	import { resolve } from '$app/paths';
	import type { SubmitFunction } from '@sveltejs/kit';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import BottomSheet from '$lib/components/BottomSheet.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Menu from '$lib/components/ui/DropdownMenu.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import { formatCents } from '$lib/domain/budget';
	import { formatMonthLabel, formatShortDate } from '$lib/domain/dateFormat';
	import { formatAmountRangeBounds, toBillRowDomKey } from '$lib/domain/upcomingBills';
	import { cardBase } from '$lib/styles';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { UpcomingBillRowView } from '$lib/server/upcoming-bills/service';
	import type { ActionData, PageData } from './$types';

	let {
		/** Server-resolved month view. Rows already carry their status, tier, amounts and
		 *  `estimatePassed`, and the two period totals are already summed over them — this page
		 *  groups and renders, it never re-filters, re-totals or re-derives a status. */
		data,
		/** Result of the last form action. Always supplied by the router; defaulted so a render that
		 *  only exercises the read-only view does not have to pass a null explicitly. */
		form = null
	}: { data: PageData; form?: ActionData } = $props();

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
	// the row background is already #fffbeb. #92400e on #fef3c7 measures 6.363:1 in a real browser
	// (design section D's plate says 6.1:1; Tailwind v4's oklch amber differs from the plate's hex).
	// Written with `!` because it overrides a colour Badge itself sets; see Badge's `class` prop.
	const OVERDUE_TIER_BADGE_CLASS = '!border-amber-200 !bg-amber-100 !text-amber-800';
	/** Uncertain tier off an overdue row (design: "bordered en zinc-400"). */
	const UNCERTAIN_TIER_BADGE_CLASS = '!border-zinc-400 !text-zinc-400';

	/** Five desktop columns: stream · date · amount · status · actions. Shared by the header row and
	 *  every data row so the two cannot drift apart. The actions column holds the inline
	 *  "Marquer payé" AND the "…" trigger side by side (design B1), hence 180px rather than the
	 *  44px a lone icon button would need. */
	const DESKTOP_GRID = 'lg:grid lg:grid-cols-[minmax(0,1fr)_150px_170px_120px_180px] lg:gap-4';

	/** Hand-applied per call site, as everywhere else in the app that renders a Bits UI menu item. */
	const MENU_ITEM_CLASS =
		'flex min-h-11 w-full items-center px-4 text-left text-sm font-semibold outline-none data-[highlighted]:bg-zinc-50';
	/** 52px, deliberately above the 44px minimum (design C2). */
	const SHEET_ITEM_CLASS =
		'flex min-h-[52px] w-full items-center rounded-lg px-2 text-left text-sm font-semibold focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none';

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
	/**
	 * Backward end of the navigator. Detection is pinned to the 12 months before today, so a month
	 * older than `oldestNavigableMonth` can hold no row at all — while `streamCount` stays non-zero,
	 * which would put the page on the "Rien de prévu en juin 2024 · Changez de mois pour les
	 * retrouver" state: a false claim about a month the user did pay bills in, recommending the one
	 * action that cannot help. The state is made UNREACHABLE rather than given a third empty-state
	 * string. Only the backward arrow is bounded — walking forward is always meaningful.
	 */
	const atOldestMonth = $derived(bills.month <= bills.oldestNavigableMonth);
	/** Same inert treatment as `noStreamsAtAll`, applied to the "previous" arrow alone. */
	const previousDisabled = $derived(noStreamsAtAll || atOldestMonth);
	/**
	 * The service computes BOTH `isCurrentMonth` and `isFutureMonth`, so "not current" is two states,
	 * not one. A past month is where the future wording was wrong — "prévu en juin 0,00 € pour
	 * +0,00 €" — and both header surfaces drop the period figures there.
	 *
	 * The reason is the TENSE, not the value: on a period that is over, "reste à sortir" / "prévu"
	 * is not a meaningful claim whatever the number happens to be. Do NOT restate this as "the
	 * totals are structurally zero on a past month" — they are not. `projectFlowOccurrences` projects
	 * forward from `flow.lastDate` regardless of today, so a stream whose last payment sits just
	 * inside the recency guard's tolerance (`isStreamStale`: about one cycle plus slack) still
	 * projects an occurrence into the period being viewed; viewing July in early August gives such a
	 * row `status: 'overdue'` (`computeOccurrenceStatus` compares against `todayIso`, not against the
	 * period) and `countsInRemainingTotal: true`, so `remainingExpenseCents` can be non-zero here.
	 */
	const isPastMonth = $derived(!bills.isCurrentMonth && !bills.isFutureMonth);
	/** Streams exist, this particular period just holds none of them. */
	const nothingDueThisPeriod = $derived(!noStreamsAtAll && bills.rows.length === 0);

	let settledExpanded = $state(false);
	/**
	 * The excluded-streams section. Collapsed by default and deliberately NOT reset by the period
	 * effect below: restoring one stream re-runs `update()`, and collapsing the section the user is
	 * working in would hide the rest of the list under them.
	 */
	let excludedOpen = $state(false);
	// Reset whenever `bills` changes identity — a period change, but also any `update()` after a row
	// mutation. The flag is about ONE render of the settled group, and leaving it set would land the
	// next data swap pre-expanded with no visible control that says so. `focusAfterAction` below
	// depends on this firing after a mutation too; see its own comment for why.
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
		const shifted = new Date(
			Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + delta, 1)
		);
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
				// "Réglées ce mois" is only true of the current one; a past month names itself.
				heading: isPastMonth
					? m.bills_group_settled_past({ month: monthName })
					: m.bills_group_settled(),
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
		if (row.cadence === 'quarterly')
			return m.bills_cadence_quarterly({ day: row.anchorDayOfMonth });
		if (row.cadence === 'yearly') return m.bills_cadence_yearly();
		return m.bills_cadence_monthly({ day: row.anchorDayOfMonth });
	}

	function kindLabel(row: UpcomingBillRowView): string {
		return row.direction === 'income' ? m.bills_kind_credit() : m.bills_kind_debit();
	}

	/** `minAmountCents`/`maxAmountCents` are UNSIGNED magnitudes, so the direction's sign is applied
	 *  with the same U+2212 glyph the fixed branch uses — Intl's own negative-currency output is an
	 *  ASCII hyphen, which would put two different minus glyphs in one list. `formatAmountRangeBounds`
	 *  owns the signing and the once-only currency symbol; it is shared with UpcomingBillsCard so the
	 *  two surfaces cannot print a range differently. */
	function amountText(row: UpcomingBillRowView): string {
		const sign = row.amountCents >= 0 ? '+' : '−';
		if (row.variability === 'variable') {
			return m.bills_amount_range(
				formatAmountRangeBounds(row.minAmountCents, row.maxAmountCents, sign, locale)
			);
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

	// ─── Row actions ──────────────────────────────────────────────────────────
	//
	// Exactly four, in one order, on both breakpoints: mark paid · ignore this occurrence · view
	// linked transactions · stop detecting. Only the fourth is rose — it is the only one that
	// touches the detected stream itself. Desktop puts them in the "…" menu (never behind hover,
	// design section "Accessibilité"), mobile in the bottom sheet the whole row opens.

	/** Settled and ignored rows carry no menu: a settled row has nothing left to act on, and an
	 *  ignored one gets the "Rétablir" link instead (design section D). */
	function isActionable(row: UpcomingBillRowView): boolean {
		return row.status === 'upcoming' || row.status === 'overdue';
	}

	/**
	 * `?q=` on the transactions page is a plain accent-insensitive substring test over the RAW
	 * `Transaction.label` (see `matchesQuery`). `row.label` is the anonymized form — digits and bank
	 * keywords stripped, title-cased — so searching it finds nothing ("Netflix Com" is not a
	 * substring of "NETFLIX.COM"). The action therefore uses the same raw, capped label the row's
	 * hidden fields already carry.
	 *
	 * This is NOT free, and the earlier "no new exposure" note here was wrong. The string was
	 * already in this page's DOM, but a query parameter also reaches browser history and — the part
	 * that matters — a reverse proxy's access log, a plaintext file that gets tailed, rotated and
	 * shipped off the host. `Caddyfile.example` drops `q` for exactly this reason, next to the
	 * `code`/`state` filter it now sits beside; an operator running a different proxy has to do the
	 * same. `encodeURIComponent` is also load-bearing: it stops a label containing `&qMode=regex`
	 * from smuggling a second parameter into the link.
	 */
	function transactionsHref(row: UpcomingBillRowView) {
		return `/transactions?q=${encodeURIComponent(row.actionPayload.label)}` as const;
	}

	/** Header line of the action sheet: date · amount · lateness (design C2). */
	function sheetMeta(row: UpcomingBillRowView): string {
		const base = m.bills_sheet_meta({
			date: formatShortDate(row.dateIso, locale),
			amount: amountText(row)
		});
		const relative = relativeDateLabel(row);
		return relative ? `${base} · ${relative}` : base;
	}

	// `ActionData` is the union of every action's return, so a bare `form.billAction` would not
	// typecheck against the branch that only carries `billError`. Narrowed once here.
	const billAction = $derived(form && 'billAction' in form ? form.billAction : null);
	/**
	 * A failure from a PREVIOUS action must not be rendered inside a dialog the user has just opened
	 * for something else — a mark-paid that 400s, then an "Ignorer" from the same menu, would put
	 * that unrelated message above the ignore confirmation. Set when a dialog opens, cleared the
	 * moment a new submission starts so the dialog's own failure is shown normally.
	 */
	let errorSuppressed = $state(false);
	const billError = $derived(
		errorSuppressed ? null : form && 'billError' in form ? form.billError : null
	);

	function bannerMessage(action: NonNullable<typeof billAction>): string {
		if (action.kind === 'paid') return m.bills_banner_paid();
		if (action.kind === 'ignore') {
			return m.bills_banner_ignored({ month: formatMonthLabel(action.month, locale) });
		}
		if (action.kind === 'exclude') return m.bills_banner_excluded({ label: action.label });
		return m.bills_banner_restored();
	}

	let sheetRow = $state<UpcomingBillRowView | null>(null);
	let pendingIgnore = $state<UpcomingBillRowView | null>(null);
	let pendingExclude = $state<UpcomingBillRowView | null>(null);
	/** Per-row in-flight set, the `acceptSuggestion` idiom — a single boolean would spin every row. */
	let submittingKeys = $state<Set<string>>(new Set());
	let confirmSubmitting = $state(false);

	/**
	 * Where focus goes once the mutation has landed (decision S8). Each target is the nearest thing
	 * that still exists afterwards: the "…" trigger an ignore was invoked from is gone from an
	 * ignored row, and an excluded stream takes its whole row with it. Deliberately never the
	 * AlertBanner, which auto-dismisses and would strand focus on a removed node.
	 *
	 * `revealSettled` is not a nicety. Ignoring or marking paid moves the row INTO the settled
	 * group, and that group renders only its first `SETTLED_COLLAPSED_ROWS` rows — on design plate
	 * B1's own month ("Réglées ce mois · 5") the row lands past the cut and is never rendered, so
	 * `getElementById` returns null, the optional call no-ops silently and focus falls to <body>.
	 * Expanding the group first is what makes the target exist.
	 *
	 * Two ticks, in this order, for a reason: the period effect resets `settledExpanded` whenever
	 * `bills` changes identity, which `update()` has just caused. Expanding before that flush would
	 * be undone by it, so the first tick lets it run and the second renders the newly revealed rows.
	 */
	async function focusAfterAction(targetId: string, revealSettled: boolean) {
		await tick();
		if (revealSettled) {
			settledExpanded = true;
			await tick();
		}
		document.getElementById(targetId)?.focus();
	}

	function rowSubmit(rowKey: string, focusId: string, revealSettled = false): SubmitFunction {
		return () => {
			errorSuppressed = false;
			submittingKeys = new Set([...submittingKeys, rowKey]);
			return async ({ result, update }) => {
				await update({ reset: false });
				submittingKeys = new Set([...submittingKeys].filter((key) => key !== rowKey));
				if (result.type === 'success') await focusAfterAction(focusId, revealSettled);
			};
		};
	}

	function confirmSubmit(
		focusId: string,
		close: () => void,
		revealSettled = false
	): SubmitFunction {
		return () => {
			errorSuppressed = false;
			confirmSubmitting = true;
			return async ({ result, update }) => {
				await update({ reset: false });
				confirmSubmitting = false;
				// The dialog stays open on failure so its error banner is readable next to the action.
				if (result.type === 'success') {
					close();
					await focusAfterAction(focusId, revealSettled);
				}
			};
		};
	}

	function openIgnore(row: UpcomingBillRowView) {
		errorSuppressed = true;
		pendingIgnore = row;
	}

	function openExclude(row: UpcomingBillRowView) {
		errorSuppressed = true;
		pendingExclude = row;
	}

	/** The banner's own "Annuler". Its own submit function rather than `confirmSubmit`'s: sharing
	 *  `confirmSubmitting` would spin a dialog button that has nothing to do with it. */
	const bannerSubmit: SubmitFunction = () => {
		errorSuppressed = false;
		return async ({ result, update }) => {
			await update({ reset: false });
			if (result.type === 'success') await focusAfterAction('bills-list', false);
		};
	};

	/** Mark paid is the one action with no confirmation, so the menu and the sheet re-submit the
	 *  row's own inline form rather than each carrying a duplicate copy of its hidden fields. */
	function submitMarkPaid(domKey: string) {
		const element = document.getElementById(`bill-paid-${domKey}`);
		if (element instanceof HTMLFormElement) element.requestSubmit();
	}

	/**
	 * Closes the sheet BEFORE opening a dialog (design C2/C3). The `tick()` is not cosmetic: both
	 * BottomSheet and Modal restore focus through `$lib/focus`, and without letting the sheet's
	 * teardown flush first its restore would fire after the dialog had already taken focus.
	 */
	async function fromSheet(open: () => void) {
		sheetRow = null;
		await tick();
		open();
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

{#snippet dotsGlyph()}
	<svg width="16" height="4" viewBox="0 0 16 4" fill="none" aria-hidden="true">
		<circle cx="2" cy="2" r="1.6" fill="currentColor" />
		<circle cx="8" cy="2" r="1.6" fill="currentColor" />
		<circle cx="14" cy="2" r="1.6" fill="currentColor" />
	</svg>
{/snippet}

<!-- The hidden payload every creator posts. `normalizedLabel` is deliberately ABSENT: the server
     derives it from the label it stores and the field is not part of `RecordStreamActionInput`, so
     posting it would be a value silently ignored. `label` is the raw capped label the write path
     stores; `displayLabel` is the anonymized one, echoed back for the result banner. An exclude
     targets the whole stream, and the service refuses one carrying a due date. -->
{#snippet actionFields(row: UpcomingBillRowView, withDueDate: boolean)}
	<input type="hidden" name="direction" value={row.actionPayload.direction} />
	<input type="hidden" name="label" value={row.actionPayload.label} />
	<input type="hidden" name="displayLabel" value={row.label} />
	<input type="hidden" name="anchorTransactionIds" value={row.actionPayload.anchorTransactionIds} />
	{#if withDueDate}
		<input type="hidden" name="dueDate" value={row.actionPayload.dueDate} />
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
						<!-- Always plural: `listObservationCandidates` only ever surfaces PAIRS
						     (OBSERVATION_CANDIDATE_OCCURRENCES = 2), a deliberate v1 scope cut. The
						     singular branch and its message key were unreachable and are gone. -->
						<span class="hidden lg:inline"
							>{m.bills_empty_progress_many({ count: candidate.occurrenceCount })}</span
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
					{:else if isPastMonth}
						<!-- No figure: on a period that is over, "reste à sortir" is not a meaningful claim
						     whatever its value — and the value is NOT always zero (see `isPastMonth`). -->
						{m.bills_header_meta_past({ count: bills.streamCount, month: monthName })}
					{:else}
						{m.bills_header_meta_future({
							count: bills.streamCount,
							month: monthName,
							expense: signedOutflow(bills.remainingExpenseCents),
							income: `+${formatCents(bills.expectedIncomeCents)}`
						})}
					{/if}
				</p>
				<!-- Mobile keeps only the figure the user acts on — but it is the same claim as the
				     desktop line, so it takes the same past-month branch. `lg:hidden` is CSS: this node
				     is in the DOM (and in `textContent`) at every width. -->
				<p class="mt-1 text-sm text-zinc-500 lg:hidden">
					{#if isPastMonth}
						{m.bills_header_meta_short_past({ month: monthName })}
					{:else}
						{m.bills_header_meta_short({ amount: formatCents(bills.remainingExpenseCents) })}
					{/if}
				</p>
			</div>
			{#if !bills.isCurrentMonth}
				<TapLink href={resolve('/upcoming-bills')}>{m.bills_back_to_current()}</TapLink>
			{/if}
		</header>

		<!-- Result of the last mutation. AlertBanner is a polite live region for variant="success", so
		     the recomputed "reste à sortir" arriving with the invalidated load is announced rather than
		     changing silently (design note D). Keyed on the result object: SvelteKit hands back a new
		     one per submission, which remounts the banner so a second identical action is announced
		     again instead of reusing an already-dismissed one.
		     The undo form sits OUTSIDE the banner on purpose — AlertBanner renders a <p>, and a <form>
		     start tag closes an open <p> in the HTML parser. The button inside carries `form=`. -->
		{#if billAction}
			{#if billAction.actionId}
				<form
					id="bill-undo-banner"
					method="POST"
					action="?/undoAction"
					class="hidden"
					use:enhance={bannerSubmit}
				>
					<input type="hidden" name="actionId" value={billAction.actionId} />
				</form>
			{/if}
			{#key billAction}
				<AlertBanner variant="success">
					{bannerMessage(billAction)}
					{#snippet action()}
						{#if billAction.actionId}
							<button
								type="submit"
								form="bill-undo-banner"
								class="-my-2.5 inline-flex min-h-11 shrink-0 items-center rounded font-semibold underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:outline-none"
							>
								{m.bills_banner_undo()}
							</button>
						{/if}
					{/snippet}
				</AlertBanner>
			{/key}
		{/if}

		<!-- A failure raised outside a confirmation dialog (mark paid, restore) — the two dialogs show
		     their own copy of this inline, next to the button that produced it. -->
		{#if billError && !pendingIgnore && !pendingExclude}
			<AlertBanner variant="error">{billError}</AlertBanner>
		{/if}

		{#if noStreamsAtAll}
			<!-- Design B4 orders the page title, this headline, then the navigator, then the card. -->
			<p class="text-sm font-semibold text-zinc-700">{m.bills_empty_headline()}</p>
		{/if}

		<!-- Period navigator. The two controls are anchors, not buttons: changing period is real
		     navigation (`?month=`), so it must survive a middle-click and work without JS. They carry
		     the explicit aria-labels the design asks of them, and go inert the same way TapLink does
		     (no href, aria-disabled, out of the tab order) when NO stream has ever been detected —
		     see `noStreamsAtAll` for why that, and not an empty month, is the condition. The BACKWARD
		     arrow carries one further condition of its own, `atOldestMonth`: the detection window has
		     a hard floor and nothing renders past it.

		     `data-sveltekit-keepfocus` is what makes the aria-live label below mean anything. Without
		     it SvelteKit's client router blurs the active element and then calls its own
		     `reset_focus()` after every client-side navigation, which lands focus on <body> — so the
		     design's "annoncé sans voler le focus" was false in the browser even though the markup
		     read right. Verified by attempting it: e2e/upcoming-bills.spec.ts reports
		     `document.activeElement` as BODY without this attribute and as the anchor with it. Both
		     arrows keep the same element mounted across the navigation, which is the precondition
		     keepfocus needs. -->
		<div class="flex items-center gap-2">
			<a
				href={previousDisabled ? undefined : resolve(monthHref(shiftMonth(bills.month, -1)))}
				data-sveltekit-keepfocus
				aria-label={m.bills_period_prev_aria()}
				aria-disabled={previousDisabled ? 'true' : undefined}
				tabindex={previousDisabled ? -1 : undefined}
				class="inline-flex h-11 w-11 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none {previousDisabled
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
				data-sveltekit-keepfocus
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
					title={isPastMonth
						? m.bills_none_due_title_past({ month: monthName })
						: m.bills_none_due_title({ month: monthName })}
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
									class="{cardBase} outline-none {row.status === 'overdue'
										? OVERDUE_ROW_CLASS
										: ''}"
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
										<div class="flex items-center justify-end gap-1">
											{#if isActionable(row)}
												<!-- The row's ONE mark-paid form. The menu item and the mobile sheet
												     `requestSubmit()` it by id rather than each rendering their own copy of
												     the hidden fields, so the three surfaces cannot post different payloads.
												     Form association is a DOM relationship: this container is display:none
												     below lg, which does not affect it.
												     The inline "Marquer payé" is rendered on EVERY actionable row, not on
												     hover: the design forbids a desktop action reachable by pointer only,
												     and a shortcut that appears under the cursor is exactly that. It is the
												     reason this column is 180px rather than the 44px an icon alone needs. -->
												<form
													id="bill-paid-{domKey}"
													method="POST"
													action="?/markPaid"
													use:enhance={rowSubmit(row.rowKey, `bill-row-${domKey}`, true)}
												>
													{@render actionFields(row, true)}
													<TapLink type="submit" disabled={submittingKeys.has(row.rowKey)}>
														{m.bills_action_mark_paid_short()}
													</TapLink>
												</form>
												<Menu
													triggerAriaLabel={m.bills_row_menu_aria({ label: row.label })}
													triggerClass="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none"
													contentClass="w-64"
												>
													{#snippet trigger()}
														{@render dotsGlyph()}
													{/snippet}
													<div class="py-1.5">
														<DropdownMenu.Item onSelect={() => submitMarkPaid(domKey)}>
															{#snippet child({ props })}
																<button
																	{...props}
																	type="button"
																	class="{MENU_ITEM_CLASS} text-zinc-700"
																>
																	{m.bills_action_mark_paid()}
																</button>
															{/snippet}
														</DropdownMenu.Item>
														<DropdownMenu.Item onSelect={() => openIgnore(row)}>
															{#snippet child({ props })}
																<button
																	{...props}
																	type="button"
																	class="{MENU_ITEM_CLASS} text-zinc-700"
																>
																	{m.bills_action_ignore()}
																</button>
															{/snippet}
														</DropdownMenu.Item>
														<DropdownMenu.Item>
															{#snippet child({ props })}
																<a
																	{...props}
																	href={resolve(transactionsHref(row))}
																	class="{MENU_ITEM_CLASS} text-zinc-700"
																>
																	{m.bills_action_view_transactions()}
																</a>
															{/snippet}
														</DropdownMenu.Item>
														<!-- The one destructive action, and the only rose item. -->
														<DropdownMenu.Item onSelect={() => openExclude(row)}>
															{#snippet child({ props })}
																<button
																	{...props}
																	type="button"
																	class="{MENU_ITEM_CLASS} text-rose-600 data-[highlighted]:bg-rose-50"
																>
																	{m.bills_action_exclude()}
																</button>
															{/snippet}
														</DropdownMenu.Item>
													</div>
												</Menu>
											{/if}
										</div>
									</div>

									<!-- Mobile: two lines plus a right-hand stack of badges. ONE focusable control per
									     row, which opens the action sheet — but only where there is something to act on:
									     a settled or ignored row renders the same content as a plain div rather than as a
									     button that announces itself as interactive and does nothing. -->
									{#if isActionable(row)}
										<button
											type="button"
											onclick={() => (sheetRow = row)}
											class="flex w-full items-start gap-3 px-4 py-3 text-left focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none lg:hidden"
										>
											{@render mobileRowBody(row)}
										</button>
									{:else}
										<div class="flex w-full items-start gap-3 px-4 py-3 text-left lg:hidden">
											{@render mobileRowBody(row)}
										</div>
									{/if}

									{#if row.status === 'ignored'}
										<!-- Rendered once per row (not per breakpoint) so the id focused after an ignore
										     is unique. `appliedActionId` is what the undo deletes; a row somehow missing
										     one keeps the link inert rather than posting an empty id. -->
										<form
											method="POST"
											action="?/undoAction"
											class="flex px-4 pb-2 lg:justify-end"
											use:enhance={rowSubmit(row.rowKey, 'bills-list')}
										>
											<input type="hidden" name="actionId" value={row.appliedActionId ?? ''} />
											<TapLink
												id="bill-restore-{domKey}"
												type="submit"
												disabled={!row.appliedActionId || submittingKeys.has(row.rowKey)}
											>
												{m.bills_restore()}
											</TapLink>
										</form>
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

		<!-- The escape hatch for "Ne plus détecter ce flux": without it an exclusion is invisible and
		     therefore permanent in practice. Collapsed, last, and rendered only when there is one —
		     a rarely needed list, not a "manage stored decisions" screen. The restore control posts to
		     the SAME `?/undoAction` the banner and the ignored-row link use; there is no second
		     endpoint and no second place the ownership check could be forgotten. -->
		{#if bills.excludedStreams.length > 0}
			<section class="border-t border-zinc-200 pt-4">
				<!-- An <h2>, like the bill groups: the toggle is the section's heading, and a bare <button>
				     would leave this section out of the page's heading outline entirely. `m-0` so the
				     element carries structure only, never the browser's heading margins — the same shape
				     the transactions detail panels use. -->
				<h2 class="m-0">
					<button
						id="bills-excluded-toggle"
						type="button"
						class="flex min-h-11 w-full items-center gap-2 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none"
						onclick={() => (excludedOpen = !excludedOpen)}
						aria-expanded={excludedOpen}
						aria-controls="bills-excluded-list"
					>
						<span id="bills-excluded-heading" class="text-sm font-semibold text-zinc-500">
							{m.bills_group_count({
								heading: m.bills_excluded_heading(),
								count: bills.excludedStreams.length
							})}
						</span>
						<span
							class="ml-auto shrink-0 text-zinc-400 transition-transform duration-150"
							class:rotate-180={excludedOpen}
						>
							{@render chevronIcon('M5 9.5 12 16l7-6.5')}
						</span>
					</button>
				</h2>
				<!-- `hidden` rather than an `{#if}`: `aria-controls` above must resolve to a real element
				     in both states, and a removed node resolves to nothing. -->
				<div
					id="bills-excluded-list"
					role="list"
					aria-labelledby="bills-excluded-heading"
					class="mt-2 space-y-2"
					hidden={!excludedOpen}
				>
					{#each bills.excludedStreams as stream (stream.actionId)}
						<div role="listitem" class="{cardBase} flex items-center gap-3 px-4 py-2">
							<Avatar initials={stream.initials} size={32} />
							<span class="min-w-0 flex-1 truncate text-sm font-medium text-zinc-700">
								{stream.label}
							</span>
							<!-- Focus target chosen at render, before the row is gone: the toggle survives as
							     long as one exclusion is left, and the section itself disappears with the last
							     one — so that case hands focus back to the list instead of to a removed node. -->
							<form
								method="POST"
								action="?/undoAction"
								use:enhance={rowSubmit(
									`excluded:${stream.actionId}`,
									bills.excludedStreams.length > 1 ? 'bills-excluded-toggle' : 'bills-list'
								)}
							>
								<input type="hidden" name="actionId" value={stream.actionId} />
								<TapLink type="submit" disabled={submittingKeys.has(`excluded:${stream.actionId}`)}>
									<!-- "Rétablir" alone names every row in the list identically. The visible word
									     stays, the accessible name carries the stream. -->
									<span aria-hidden="true">{m.bills_restore()}</span>
									<span class="sr-only"
										>{m.bills_excluded_restore_aria({ label: stream.label })}</span
									>
								</TapLink>
							</form>
						</div>
					{/each}
				</div>
			</section>
		{/if}
	</section>
</main>

{#snippet mobileRowBody(row: UpcomingBillRowView)}
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
{/snippet}

<!-- Mobile action sheet (design C2). Mounted only while a row is selected; BottomSheet is
     `lg:hidden` and owns its own focus trap and restore-on-close. -->
{#if sheetRow}
	{@const row = sheetRow}
	{@const domKey = toBillRowDomKey(row.rowKey)}
	<BottomSheet open ariaLabel={row.label} onClose={() => (sheetRow = null)}>
		<div class="pb-2">
			<p class="text-base font-bold text-zinc-950">{row.label}</p>
			<p class="mt-0.5 text-xs text-zinc-500">{sheetMeta(row)}</p>
		</div>
		<div class="flex flex-col">
			<button
				type="button"
				class="{SHEET_ITEM_CLASS} text-zinc-700"
				onclick={() => {
					sheetRow = null;
					submitMarkPaid(domKey);
				}}
			>
				{m.bills_action_mark_paid()}
			</button>
			<button
				type="button"
				class="{SHEET_ITEM_CLASS} text-zinc-700"
				onclick={() => fromSheet(() => openIgnore(row))}
			>
				{m.bills_action_ignore()}
			</button>
			<a href={resolve(transactionsHref(row))} class="{SHEET_ITEM_CLASS} text-zinc-700">
				{m.bills_action_view_transactions()}
			</a>
			<!-- The one destructive action, and the only rose item. -->
			<button
				type="button"
				class="{SHEET_ITEM_CLASS} text-rose-600"
				onclick={() => fromSheet(() => openExclude(row))}
			>
				{m.bills_action_exclude()}
			</button>
		</div>
	</BottomSheet>
{/if}

<!-- Ignoring an occurrence is reversible and local to one period, so the final button stays the
     default black (design C3) — `tone="danger"` is reserved for the exclude below. -->
{#if pendingIgnore}
	{@const row = pendingIgnore}
	<form
		method="POST"
		action="?/ignoreOccurrence"
		use:enhance={confirmSubmit(
			`bill-restore-${toBillRowDomKey(row.rowKey)}`,
			() => (pendingIgnore = null),
			true
		)}
	>
		{@render actionFields(row, true)}
		<ConfirmDialog
			open
			title={m.bills_ignore_confirm_title()}
			description={m.bills_ignore_confirm_description({ label: row.label, month: monthLabel })}
			confirmLabel={m.bills_ignore_confirm_cta({ month: monthName })}
			confirmLoading={confirmSubmitting}
			onClose={() => (pendingIgnore = null)}
		>
			{#if billError}
				<AlertBanner variant="error" class="mt-2">{billError}</AlertBanner>
			{/if}
		</ConfirmDialog>
	</form>
{/if}

{#if pendingExclude}
	{@const row = pendingExclude}
	<form
		method="POST"
		action="?/excludeStream"
		use:enhance={confirmSubmit('bills-list', () => (pendingExclude = null))}
	>
		<!-- No due date: an exclude targets the whole stream and the service refuses one carrying it. -->
		{@render actionFields(row, false)}
		<ConfirmDialog
			open
			title={m.bills_exclude_confirm_title()}
			description={m.bills_exclude_confirm_description({ label: row.label })}
			confirmLabel={m.bills_exclude_confirm_cta()}
			tone="danger"
			confirmLoading={confirmSubmitting}
			onClose={() => (pendingExclude = null)}
		>
			{#if billError}
				<AlertBanner variant="error" class="mt-2">{billError}</AlertBanner>
			{/if}
		</ConfirmDialog>
	</form>
{/if}
