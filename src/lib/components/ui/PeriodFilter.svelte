<script lang="ts" module>
	let idCounter = 0;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as m from '$lib/paraglide/messages';
	import { labelledValue } from '$lib/domain/typography';
	import Tooltip from './Tooltip.svelte';
	import BottomSheet from '../BottomSheet.svelte';
	import { formatPeriodLabel, type PeriodCopy } from '$lib/domain/periodLabel';
	import {
		PERIOD_EPOCH_FLOOR,
		PERIOD_PRESET_IDS,
		matchPeriodPreset,
		periodPresetRange,
		type PeriodPresetId
	} from '$lib/domain/periodPresets';
	import RangeCalendar, { type RangeCalendarRange } from './RangeCalendar.svelte';
	import { reopeningMonthAnchor, type RangeCalendarCopy } from '$lib/domain/rangeCalendar';
	// `type="text"` + `inputmode="numeric"`, NEVER `type="date"`: the grammar and the reason both
	// live in domain/dateField.ts now, so /reports and the dashboard can use the same one. They
	// could not while these were private functions here, which is why they kept native inputs.
	import { isoToDisplay, displayToIso, toIsoOrNull } from '$lib/domain/dateField';
	import type { locales } from '$lib/paraglide/runtime';

	/**
	 * The Période dimension of the /transactions filter bar: a trigger + panel SIBLING of
	 * FilterDropdown.svelte, not a mode on it.
	 *
	 * Why a sibling rather than a variant: FilterDropdown is a managed-focus LISTBOX (arrow keys,
	 * aria-activedescendant, options that are deliberately never independently focusable — see the
	 * long comment at the top of that file). This panel offers presets AND two free-text date
	 * inputs, and the inputs must be genuinely focusable and editable with the keyboard exactly like
	 * any other text field. Bolting that onto a listbox would mean either making the inputs
	 * non-conformant listbox options (illegal — an <input> cannot be a role="option") or making the
	 * preset buttons pretend to be a single-selection list they are not. Two different interaction
	 * models, so two different components; the trigger markup, the clear "×", the footer slot and
	 * the Escape/focus-out mechanics are still copied verbatim from FilterDropdown so the two read as
	 * one family.
	 *
	 * Période is also the one dimension exempt from the bar's ellipsis-on-truncate convention: its
	 * value is a composite range, and cutting a range with "…" produces a DIFFERENT, unlabelled
	 * period rather than a shortened one. See `$lib/domain/periodLabel.ts` for the shortening ladder
	 * that replaces truncation here.
	 */
	let {
		dimensionLabel,
		from,
		to,
		invalid,
		locale,
		todayIso,
		presets = PERIOD_PRESET_IDS,
		backLabel = m.transactions_period_sheet_back(),
		triggerSize = 'filter',
		allowCustomRung = true,
		surface = 'desktop',
		clearAriaLabel,
		onApply,
		onClear,
		footer
	}: {
		dimensionLabel: string;
		from: string;
		to: string;
		invalid: boolean;
		/** The negotiated locale, not an arbitrary string — see RangeCalendar's prop for why. */
		locale: (typeof locales)[number];
		todayIso: string;
		/**
		 * Which presets the shortcut block offers. Defaults to the six /transactions ships with, so
		 * that screen is unchanged by the widening.
		 *
		 * A prop rather than a constant because the dashboard and /reports carry a 90-day window and an
		 * all-time period, and do not carry the quarter, the year or the twelve months. One
		 * hardcoded list could serve only one of the two sets, and #495 refused to mount this
		 * component at those sites for exactly that reason rather than replace their period model
		 * as a side effect.
		 *
		 * The 102px layout budget is a ceiling on ANY set, not a fact about the first one written:
		 * `periodPresets.spec.ts` holds both to six.
		 */
		presets?: readonly PeriodPresetId[];
		/**
		 * What the mobile sheet's way out is called. Defaults to "Filtres", which is correct on
		 * /transactions, where this sheet is reached FROM the Filtres sheet and returns to it.
		 *
		 * A prop because the dashboard and /reports open the sheet straight from the page: there is
		 * no Filtres sheet behind it, so the default names a screen that does not exist. The button
		 * closes the sheet either way, which is why nothing could catch this except reading the word
		 * on a 390 screenshot.
		 */
		backLabel?: string;
		/**
		 * How tall the desktop trigger draws, which is a fact about the ROW it sits in rather than
		 * about this component.
		 *
		 * `filter` (34px, the default) is /transactions' filter bar, where every sibling is a 34px
		 * chip. `field` (44px) is the dashboard and /reports header rows, where the siblings are
		 * `size="field"` buttons and the Select this replaced was `h-11`; Button.svelte's own
		 * comment names 44px "the primary-form-field template: Select".
		 *
		 * Ignored on `surface="mobile"`, which is already 44px for its own reason.
		 */
		triggerSize?: 'filter' | 'field';
		/** The desktop-only "période personnalisée" rung: touch has no hover, so a Tooltip that rung
		 *  relies on is not recoverable. The mobile caller passes `false`. */
		allowCustomRung?: boolean;
		surface?: 'desktop' | 'mobile';
		clearAriaLabel: string;
		onApply: (range: { from: string; to: string }) => void;
		onClear: () => void;
		footer?: Snippet;
	} = $props();

	idCounter += 1;
	const uid = `period-filter-${idCounter}`;
	const panelId = `${uid}-panel`;
	const messageId = `${uid}-message`;

	let open = $state(false);
	let openButtonEl = $state<HTMLButtonElement | null>(null);
	let panelEl = $state<HTMLDivElement | null>(null);
	let fromInputEl = $state<HTMLInputElement | null>(null);

	/**
	 * THE SINGLE SOURCE OF TRUTH, per design 6E. Three things in this panel can write a period — the
	 * presets, the grid, and these two fields — and with three writers it has to be said which one is
	 * right. The couple "Du / Au" is the truth; the grid and the presets are two ways of WRITING it.
	 * The filter's state is never read anywhere else.
	 *
	 * These stay as typed BUFFERS rather than ISO dates because a half-typed "03/0" is a legitimate
	 * intermediate state that must not be clobbered or round-tripped through a parser. The ISO values
	 * the calendar consumes are derived from them, one-way; the calendar writes back into the buffers
	 * rather than into a second copy, so there is no cycle and no second truth to keep in agreement.
	 */
	let draftFromDisplay = $state('');
	let draftToDisplay = $state('');

	/**
	 * Which field was written last. Feeds `reopeningMonthAnchor`, whose one exception is that a panel
	 * reopened after the END was written shows the END's month — bringing it back to the start would
	 * make the reader walk their own path a second time.
	 */
	let lastEdited = $state<'from' | 'to' | null>(null);

	/**
	 * The armed preset, held separately from the derived `selectedPreset`.
	 *
	 * It cannot be derived, and that is the whole of 6E's "aucun état où « Ce mois-ci » est marqué
	 * actif alors que les champs disent autre chose": a preset must go dark the INSTANT a day is
	 * clicked, before the range is even complete — at which point the draft still equals the preset's
	 * range and any derivation would keep it lit. Arming is an event, not a computation.
	 */
	let armedPreset = $state<PeriodPresetId | null>(null);

	/**
	 * The panel's height ceiling, measured from the trigger rather than assumed.
	 *
	 * It was `max-h-[70vh]`, which is a cap on the panel's SIZE and says nothing about where the
	 * panel starts. Anchored under a trigger 290px down a 900px viewport, 70vh (630px) put the
	 * panel's bottom edge at 920 — 20px below the fold — and "Appliquer" at y=960, entirely off
	 * screen. The panel scrolls internally, so nothing was unreachable, but the primary action was
	 * behind a scroll the user had no reason to expect, on the surface where 6M's sticky-footer rule
	 * exists precisely because that is unacceptable on the other one.
	 *
	 * The floor of 240 keeps the panel usable rather than collapsing it to a sliver when the trigger
	 * is near the bottom of a short window; below that the internal scroll is the better failure.
	 */
	let panelMaxHeight = $state<number | null>(null);

	$effect(() => {
		if (!open || surface === 'mobile') {
			panelMaxHeight = null;
			return;
		}
		const trigger = openButtonEl?.getBoundingClientRect();
		if (!trigger) return;
		panelMaxHeight = Math.max(240, Math.round(window.innerHeight - trigger.bottom - 16));
	});

	/**
	 * On opening, focus goes to THE GRID — the range start if one is placed, otherwise today — per
	 * design 6's focus rule, not to the "Du" field.
	 *
	 * It used to go to the field, which quietly cost the grid its whole purpose for a keyboard or
	 * screen-reader user: they landed in a text input and had to discover, unprompted, that a
	 * calendar existed further down. The grid is a single tab stop with a roving tabindex, so the
	 * cell bits-ui has marked `tabindex="0"` IS the anchor — it is the start when a range exists and
	 * the placeholder day otherwise, which is exactly the rule.
	 *
	 * At 390 this also settles a race that was previously decided by effect-scheduling order:
	 * BottomSheet runs its own `focusFirst` on open, which would land on the "Toutes" row. Focusing
	 * deliberately here, after a tick, makes the outcome a decision rather than a coincidence.
	 */
	$effect(() => {
		if (!open) return;
		const container = surface === 'mobile' ? document : panelEl;
		queueMicrotask(() => {
			const anchor = (container ?? document).querySelector<HTMLElement>(
				'[data-bits-day][tabindex="0"]'
			);
			if (anchor) anchor.focus();
			else fromInputEl?.focus();
		});
	});

	const copy: PeriodCopy = {
		openStart: (date) => m.transactions_period_open_start({ date }),
		openEnd: (date) => m.transactions_period_open_end({ date }),
		custom: m.transactions_period_custom(),
		invalid: m.transactions_period_invalid_value()
	};

	const label = $derived(formatPeriodLabel({ from, to, invalid, locale, allowCustomRung, copy }));

	/**
	 * Active means a range is set at all, invalid or not. An invalid range is still something the
	 * user chose, so it renders as active with the neutral border plus the `(!)` glyph and the word
	 * — never as resting, which would look like the filter had quietly been dropped.
	 */
	const isActive = $derived(from !== '' || to !== '');

	/** aria-label ALWAYS carries the unabridged form, whichever rung the value slot renders. */
	const fullAriaLabel = $derived(labelledValue(dimensionLabel, label.full));

	/**
	 * No `selectedPreset` derived any more, deliberately. The armed state used to be computed from
	 * the LIVE range, which cannot express 6E's requirement that a preset go dark the moment a day is
	 * clicked: at that instant the draft still equals the preset's range, so any derivation keeps it
	 * lit while the fields say something else. `matchPeriodPreset` is now called once, on opening,
	 * to seed `armedPreset` — see `toggleOpen`.
	 */

	/** ISO or null, derived one-way from the typed buffers. A half-typed date is simply not a date. */
	const draftFrom = $derived(toIsoOrNull(draftFromDisplay));
	const draftTo = $derived(toIsoOrNull(draftToDisplay));

	/**
	 * What the GRID is told, which is not always what the fields say.
	 *
	 * An epoch floor is withheld. The all-time period has no start the reader picked, and passing 1970 as a
	 * placed bound makes bits-ui move the month on screen to January 1970 through its own
	 * `bind:placeholder` write-back. MEASURED rather than reasoned: with the floor passed through,
	 * `reopeningMonthAnchor` correctly returned 2026-06-17 and the caption still read January
	 * 1970, because the anchor rule and the library are two different writers of the same view
	 * state and the library writes last.
	 *
	 * So the anchor rule alone could not fix it, and the fix is here rather than there. The Du field
	 * still reads 01/01/1970: the field is what will be APPLIED and must stay honest. The grid draws
	 * one bound instead of two, which is the truthful picture of a range with no chosen start.
	 */
	const calendarValue = $derived<RangeCalendarRange>({
		start: draftFrom === PERIOD_EPOCH_FLOOR ? null : draftFrom,
		end: draftTo
	});

	const anchorIso = $derived(
		reopeningMonthAnchor({ from: draftFrom, to: draftTo, lastEdited, todayIso })
	);

	/**
	 * "Appliquer" is dead until BOTH bounds are placed, per 6C: "un seul clic ne fait pas une plage.
	 * Tant que la fin manque, « Appliquer » reste éteint."
	 *
	 * It required only ONE bound until a trace through the server showed that to be a false
	 * affordance rather than a lenient one: `parseCustomDateRange` refuses a half-range outright
	 * (`if (!from || !toInclusive) throw error(400)`), so a live Apply with a single bound placed sent
	 * a request whose only possible outcome was the "Période invalide" state. The panel was offering
	 * an action guaranteed to fail, and then reporting the failure as though the user had mistyped.
	 *
	 * Requiring both also closes the partial-buffer case: with one field a complete date and the
	 * other a fragment like "05/06/202", `toIsoOrNull` returns null for the fragment, so Apply stays
	 * inert instead of sending the fragment verbatim as a URL param.
	 */
	const canApply = $derived(draftFrom !== null && draftTo !== null);

	const calendarCopy: RangeCalendarCopy = {
		rangeStart: m.transactions_period_calendar_range_start(),
		rangeEnd: m.transactions_period_calendar_range_end(),
		awaitingEnd: ({ date }) => m.transactions_period_calendar_awaiting_end({ date }),
		rangeSelected: ({ from: f, to: t, days }) =>
			m.transactions_period_calendar_range_selected({ from: f, to: t, days }),
		empty: m.transactions_period_calendar_empty()
	};

	const longDateFormatter = $derived(
		new Intl.DateTimeFormat(locale, {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			year: 'numeric',
			timeZone: 'UTC'
		})
	);

	const monthCaptionFormatter = $derived(
		new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' })
	);

	function formatLongDate(iso: string): string {
		if (!iso) return '';
		return longDateFormatter.format(new Date(`${iso}T00:00:00.000Z`));
	}

	function formatMonthCaption(iso: string): string {
		if (!iso) return '';
		return monthCaptionFormatter.format(new Date(`${iso}T00:00:00.000Z`));
	}

	const datePlaceholder = `${m.transactions_period_day_placeholder()}/${m.transactions_period_month_placeholder()}/${m.transactions_period_year_placeholder()}`;

	const PRESET_LABELS: Record<PeriodPresetId, () => string> = {
		thisMonth: m.transactions_period_preset_this_month,
		lastMonth: m.transactions_period_preset_last_month,
		last30Days: m.transactions_period_preset_last_30_days,
		thisQuarter: m.transactions_period_preset_this_quarter,
		thisYear: m.transactions_period_preset_this_year,
		last12Months: m.transactions_period_preset_last_12_months,
		// The two set B ids reuse the keys the dashboard and /reports already render in their own
		// period control, rather than adding a second pair saying the same words. A screen must not
		// be able to name the same period one way in one place and another way elsewhere
		// because a translator saw two keys.
		last90Days: m.reports_period_last_90_days,
		allTime: m.reports_period_all_time
	};

	function close({ restoreFocus }: { restoreFocus: boolean }): void {
		open = false;
		if (restoreFocus) openButtonEl?.focus();
	}

	function toggleOpen(): void {
		if (open) {
			close({ restoreFocus: false });
			return;
		}
		draftFromDisplay = isoToDisplay(from);
		draftToDisplay = isoToDisplay(to);
		// Reopening restores the preset's armed state when the live range still IS that preset, so a
		// panel closed on "Ce mois-ci" does not come back with nothing marked.
		armedPreset = matchPeriodPreset({ from, to }, todayIso, presets);
		// `lastEdited` is deliberately NOT cleared here. It is the whole input to 6E's single
		// exception — "si la dernière chose écrite était « Au », la réouverture montre le mois de la
		// fin" — and clearing it on open destroys that memory at the exact moment `anchorIso` is about
		// to be read, so the grid would open on the start month unconditionally and the exception
		// would never fire. `reopeningMonthAnchor` would still pass its own unit tests throughout,
		// because the defect is in the wiring, not the rule.
		open = true;
	}

	/**
	 * A preset writes both fields and moves the grid to the start's month. It does NOT apply: with
	 * three ways to write a period, applying on every write means a preset brushed by accident fires
	 * a request that then has to be undone by touching something else. "Appliquer" is the single
	 * point of validation for all three writers — see the button's own comment.
	 */
	function armPreset(id: PeriodPresetId): void {
		const range = periodPresetRange(id, todayIso);
		draftFromDisplay = isoToDisplay(range.from);
		draftToDisplay = isoToDisplay(range.to);
		armedPreset = id;
		lastEdited = 'from';
	}

	/**
	 * Every write that is not a preset disarms the preset, immediately. Called from the grid and from
	 * both fields rather than inferred, for the reason given at `armedPreset`.
	 */
	function disarmPreset(): void {
		armedPreset = null;
	}

	/**
	 * ONE backward click produces TWO synchronous `onValueChange` calls from bits-ui, and this flag is
	 * what stops the second one from undoing the first.
	 *
	 * Clicking a day before the placed start makes bits-ui's `handleCellClick` swap the bounds
	 * internally: it calls `#setStartValue(earlierDay)` — emitting `{earlier, null}` — and then
	 * `#setEndValue(oldStart)` immediately after, emitting `{earlier, oldStart}`, both in the same
	 * tick. The restart guard below only recognises the FIRST, because by the time the second arrives
	 * `draftFrom` already equals `next.start` and the "start moved" test is false. Without this flag
	 * the second call writes the old start back as an end, which is precisely the silent permutation
	 * 6E forbids: click 10 June then 5 June and you would land on 5 June → 10 June.
	 *
	 * Cleared on a microtask rather than on the next call, so that a click which for any reason emits
	 * only once cannot leave the flag armed and swallow the user's NEXT, legitimate click. Both
	 * bits-ui events are synchronous, so they are always both seen before the microtask runs.
	 */
	let swallowSwapCompletion = false;

	/**
	 * The grid wrote a range.
	 *
	 * The one rule here that is not bits-ui's: clicking a day BEFORE the start does not silently swap
	 * the bounds, it restarts the range at that day. A silent permutation loses the reader the thread
	 * of what they just designated — they pointed at a day and the panel quietly decided it meant
	 * something else. Re-clicking the start itself is left alone: that is a legitimate one-day range,
	 * not an error to correct.
	 */
	function onCalendarChange(next: RangeCalendarRange): void {
		disarmPreset();

		if (swallowSwapCompletion) {
			swallowSwapCompletion = false;
			return;
		}

		const hadStartOnly = draftFrom !== null && draftTo === null;
		const startMoved = next.start !== null && next.start !== draftFrom;

		if (hadStartOnly && startMoved) {
			swallowSwapCompletion = true;
			queueMicrotask(() => {
				swallowSwapCompletion = false;
			});
			draftFromDisplay = isoToDisplay(next.start ?? '');
			draftToDisplay = '';
			lastEdited = 'from';
			return;
		}

		draftFromDisplay = isoToDisplay(next.start ?? '');
		draftToDisplay = isoToDisplay(next.end ?? '');
		// The end is what the second click writes, and it is what the panel should reopen on.
		lastEdited = next.end ? 'to' : 'from';
	}

	function applyDraft(): void {
		const range = { from: displayToIso(draftFromDisplay), to: displayToIso(draftToDisplay) };
		close({ restoreFocus: true });
		onApply(range);
	}

	function clearAll(): void {
		close({ restoreFocus: true });
		onClear();
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			// Conditional on `open`, exactly as FilterDropdown's guard (FilterDropdown.svelte:223-232):
			// with the panel closed this component has nothing to dismiss, and unconditionally
			// stopping propagation here is what makes one Escape close two things — the detail panel's
			// own Escape predates this component and must still receive the key when this is closed.
			if (open) {
				event.stopPropagation();
				close({ restoreFocus: true });
			}
		}
	}

	/**
	 * Copied verbatim from FilterDropdown.svelte:246-262 (onFocusOut / closeIfOutside), including its
	 * reasoning: without this the panel is a keyboard trap in reverse (nothing inside it is in the
	 * Tab sequence at the right point to close it), and the `relatedTarget === null` case must NOT
	 * close the panel — that means focus left the document entirely (another window, the browser
	 * chrome), not that the user clicked away, and closing behind their back would be wrong.
	 */
	function onFocusOut(event: FocusEvent): void {
		if (!open) return;
		// The sheet owns its own dismissal at 390 (Escape, backdrop, swipe, focus trap), and this
		// handler must not run there. It closes on "focus is no longer inside `panelEl`", and
		// `panelEl` is the DESKTOP popover, which the mobile branch never renders — so the moment
		// BottomSheet moved focus into itself, `panelEl?.contains(next)` was `undefined`, this read it
		// as focus leaving the component, and the sheet closed in the same tick it opened. The trigger
		// went straight back to aria-expanded="false" with no error anywhere.
		if (surface === 'mobile') return;
		const next = event.relatedTarget as Node | null;
		if (next === null) return;
		if (panelEl?.contains(next) || openButtonEl?.contains(next)) return;
		close({ restoreFocus: false });
	}

	function closeIfOutside(event: MouseEvent): void {
		if (!open) return;
		// Same reason as `onFocusOut`: at 390 the backdrop is what dismisses, and two mechanisms
		// racing to close one surface is how this page previously pushed two history entries for a
		// single keystroke.
		if (surface === 'mobile') return;
		const target = event.target as Node | null;
		if (!target) return;
		if (panelEl?.contains(target) || openButtonEl?.contains(target)) return;
		close({ restoreFocus: false });
	}
</script>

<svelte:window onclick={closeIfOutside} />

<div class="relative inline-block" onfocusout={onFocusOut}>
	<!-- Mirrors FilterDropdown's trigger group exactly: 34px desktop / 44px mobile, overflow-hidden
	     rounded-xl border, and (when active) two ADJOINED buttons rather than one nested inside the
	     other (nested buttons are invalid HTML).

	     Mobile used to draw at 36px visually while growing each button's TAP area to 44px via
	     `min-h-[44px] -my-1` (transparent overflow, so the row's own layout height never changed) —
	     design section 7's regex-toggle pattern. Design section 6I now asks for the VISUAL row at
	     44px too, to line up with the other three mobile filter-bar triggers (Filtres · N, Catégorie,
	     Étiquette), which already draw at 44px via this exact pair of classes
	     (min-h-11 on the group, min-h-11 on each button — see +page.svelte's Catégorie/Étiquette
	     groups). `h-11` on the group plus `items-stretch` alone measured 42px, not 44: the group's
	     own 1px top+bottom border eats 2px out of a FIXED height's content box, and a stretched child
	     fills the content box, not the border-box. `min-h-11` on the group is a FLOOR the border-box
	     must clear, so the browser grows the box until the bordered total is 44 — the same mechanism
	     already proven correct on the other two groups. The negative-margin trick is removed: it
	     compensated for a too-short VISUAL row, and the row is no longer too short.

	     `triggerSize === 'field'` takes the same `min-h-11` branch on DESKTOP, for callers whose row
	     is a row of 44px fields rather than of 34px chips. Same mechanism, same reason it has to be
	     a floor rather than a fixed height. -->
	{#snippet triggerGroup()}
		<div
			data-testid="period-trigger-group"
			class="inline-flex items-stretch overflow-hidden rounded-xl border {surface === 'mobile' ||
			triggerSize === 'field'
				? 'min-h-11'
				: 'h-[34px]'} {isActive ? 'border-zinc-900 bg-white' : 'border-zinc-200 bg-white'}"
		>
			<button
				bind:this={openButtonEl}
				type="button"
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={open ? panelId : undefined}
				aria-label={isActive ? fullAriaLabel : undefined}
				aria-describedby={invalid ? messageId : undefined}
				{...invalid ? { 'aria-invalid': 'true' } : {}}
				class="inline-flex min-w-[24px] items-center gap-1.5 px-3 text-sm text-zinc-900 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none {surface ===
				'mobile'
					? 'min-h-11'
					: ''}"
				onclick={toggleOpen}
				onkeydown={onKeydown}
			>
				{#if isActive}
					<!-- The dimension name never truncates. -->
					<span class="whitespace-nowrap">{dimensionLabel}</span>
					<span aria-hidden="true">:</span>
					{#if invalid}
						<!-- NEUTRAL, never destructive/rose or overdue/amber: the group's border above stays
					     border-zinc-900 either way. The glyph alone must not carry the signal (colour
					     alone is not sufficient), which is why the word itself is in `label.text` too. -->
						<span class="text-zinc-600" aria-hidden="true">(!)</span>
					{/if}
					{#if label.shortened}
						<!-- Tooltip, never `title`: `title` only fires on mouse hover and leaves the sighted
					     keyboard user with no way to read the unabridged form. The dotted underline is the
					     only visual cue left here — the Tooltip itself now wraps the trigger GROUP, not
					     this span, so that focusing the button actually opens it (see the comment beside
					     the wrapping below). -->
						<span
							data-testid="period-value"
							class="max-w-[190px] tabular-nums underline decoration-zinc-400 decoration-dotted underline-offset-2"
							>{label.text}</span
						>
					{:else}
						<!-- No `truncate` here, deliberately, on either branch: Période is exempt from the
					     bar's ellipsis convention because a truncated range is a DIFFERENT period, and
					     nothing on screen says which one is real. The 190px cap is enforced upstream by
					     the shortening ladder in periodLabel.ts, not by CSS overflow. -->
						<span data-testid="period-value" class="max-w-[190px] tabular-nums">{label.text}</span>
					{/if}
				{:else}
					<span class="whitespace-nowrap">{dimensionLabel}</span>
				{/if}
				<svg
					class="h-4 w-4 shrink-0 text-zinc-400 {open ? 'rotate-180' : ''}"
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
			{#if isActive}
				<span class="w-px self-stretch bg-zinc-200" aria-hidden="true"></span>
				<button
					type="button"
					class="inline-flex items-center justify-center px-2.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none {surface ===
					'mobile'
						? 'min-h-11 min-w-11'
						: 'min-w-[24px]'}"
					aria-label={clearAriaLabel}
					onclick={clearAll}
				>
					<span aria-hidden="true">×</span>
				</button>
			{/if}
		</div>
	{/snippet}

	<!--
		The action pair, rendered in ONE of two places depending on the surface, from one definition.

		On desktop it sits in the flow at the foot of the panel. At 390 it becomes the sheet's STICKY
		FOOTER — outside the scrolling body, so "Appliquer" is reachable whatever the sheet's height
		and whatever the virtual keyboard has taken. That is the referential's new sheet-footer rule:
		in a sheet, the primary action never scrolls. A sheet dimensioned to "just fit" on one handset
		breaks on the next one, so reaching the validation must never be a function of remaining
		height.

		Both sizes grow to the touch floor at 390: the design gives "Appliquer la période" 48px and
		"Effacer" 44px, against 36px on desktop.

		`aria-disabled` on a still-focusable button rather than native `disabled`: the repo's rule for
		any inactive control that has to explain itself. A native `disabled` leaves the tab sequence,
		taking its own explanation out of reach of the keyboard user who most needs it.
	-->
	{#snippet actionRow()}
		<div class="flex w-full flex-wrap gap-2 {surface === 'mobile' ? 'px-1 pt-3 pb-2' : ''}">
			<button
				type="button"
				aria-disabled={canApply ? undefined : 'true'}
				aria-describedby={canApply ? undefined : `${uid}-apply-hint`}
				class="flex-1 rounded-lg border px-3 text-sm {surface === 'mobile'
					? 'h-12'
					: 'h-9'} {canApply
					? 'border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-700'
					: 'cursor-default border-zinc-200 bg-zinc-100 text-zinc-400'}"
				onclick={() => {
					if (!canApply) return;
					applyDraft();
				}}
			>
				{surface === 'mobile' ? m.transactions_period_apply_sheet() : m.transactions_period_apply()}
			</button>
			<button
				type="button"
				class="rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-700 hover:bg-zinc-50 {surface ===
				'mobile'
					? 'h-11'
					: 'h-9'}"
				onclick={clearAll}
			>
				{m.transactions_period_clear()}
			</button>
			{#if !canApply}
				<p id="{uid}-apply-hint" class="w-full text-xs text-zinc-500">
					{m.transactions_period_apply_hint()}
				</p>
			{/if}
		</div>
	{/snippet}

	{#if label.shortened}
		<!-- The Tooltip wraps the GROUP, not a span inside the button. Tooltip opens on its wrapper's
		     `focusin`, and `focusin` bubbles UP: a Tooltip nested inside the button can never see the
		     button being focused, so it degrades to hover-only — which is exactly the `title` behaviour
		     the design rejects. An e2e test focuses the trigger and reads the tooltip, and it was
		     watched fail against the nested arrangement. -->
		<Tooltip label={label.full} wrapperClass="relative inline-flex">
			{@render triggerGroup()}
		</Tooltip>
	{:else}
		{@render triggerGroup()}
	{/if}

	<!--
		ONE body definition, rendered into one of two containers.

		At 390 Période is NOT a popover, and that is a measured decision rather than a preference: the
		trigger starts at x = 202px in the filter row, so a panel anchored to its left edge at the
		desktop width of 254px has its right edge at 456px — 66px outside a 390px viewport. What falls
		outside is not decoration: the second preset column, the "Au" field and "Appliquer". The panel
		does not scroll sideways, so a mobile reader could not validate a period at all and had no
		finger-level way around it. A sheet removes width as a variable entirely.
	-->
	{#snippet panelBody()}
		<!-- `max-height` + `overflow-y: auto` so a panel taller than the space below its trigger
			     scrolls inside itself rather than running off the bottom of the screen. Same pattern,
			     and same legality argument, as the detail panel in transactions/+page.svelte: the
			     element that scrolls is the element itself, and an overflow SELF does not break the
			     absolute positioning the way an overflow ANCESTOR would break a sticky one.

			     Note what this does to the horizontal axis, because it is the reason the width
			     assertion in the spec is kept rather than retired: a scroll container clips BOTH axes
			     (`overflow-x` computes to `auto` once `overflow-y` is not `visible`). Before this line
			     existed, a child wider than the panel painted outside the border and was at least
			     visible — the `Appliquer` button did exactly that, 58px past the right edge, on every
			     desktop open. From here on the same mistake is silently hidden instead. -->

		<!-- The return row: always at the head, never conditional, mirroring FilterDropdown's own
			     "Toutes" row. Clears the whole dimension rather than applying a range. -->
		<button
			type="button"
			class="mb-2 block w-full rounded-lg px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-50"
			onclick={clearAll}
		>
			{m.transactions_period_all()}
		</button>

		<div class="border-t border-zinc-100 pt-2">
			<p class="mb-1 text-xs text-zinc-500">{m.transactions_period_presets_label()}</p>
			<!-- Plain <button>s, deliberately NOT a listbox: this is a picker of independent
				     shortcuts sitting beside two free-text inputs, not a single-selection list of
				     mutually exclusive options navigated by arrow keys. Adopting FilterDropdown's
				     managed-focus / aria-activedescendant model here would oblige clamped arrow
				     navigation and non-focusable rows for a control where every row is a normal,
				     independently focusable button — no reader gains anything from pretending
				     otherwise.

				     Two fixed columns rather than a wrap: the design's preset block is budgeted at
				     102px, which is exactly three 30px rows plus two 6px gaps. A wrap would let the
				     block's height follow the label lengths and take the panel's total height with
				     it. Every set this can be mounted with is asserted to hold at most six, for the
				     same reason. -->
			<div
				role="group"
				aria-label={m.transactions_period_presets_label()}
				class="grid grid-cols-2 gap-1.5"
			>
				{#each presets as id (id)}
					<button
						type="button"
						aria-pressed={armedPreset === id}
						class="flex items-center rounded-lg border px-2 text-left font-medium whitespace-nowrap {surface ===
						'mobile'
							? 'h-11 text-[13.5px]'
							: 'h-[30px] text-[11.5px]'} {armedPreset === id
							? 'border-zinc-900 bg-zinc-100 text-zinc-900'
							: 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'}"
						onclick={() => armPreset(id)}
					>
						{PRESET_LABELS[id]()}
					</button>
				{/each}
			</div>
		</div>

		<!-- The grid. It writes into the same two buffers the fields do, and disarms the preset on
			     every write — see `onCalendarChange`. Nothing about the Période dimension lives inside
			     it: it takes ISO strings, formatters and copy, so /reports can mount the same grid with
			     its own presets and its own sentences. -->
		<div class="mt-3 border-t border-zinc-100 pt-2">
			<RangeCalendar
				value={calendarValue}
				onValueChange={onCalendarChange}
				size={surface === 'mobile' ? 'touch' : 'mouse'}
				{locale}
				{todayIso}
				{anchorIso}
				copy={calendarCopy}
				{formatLongDate}
				{formatMonthCaption}
				gridLabel={m.transactions_period_calendar_grid_label()}
				previousMonthLabel={m.transactions_period_calendar_prev_month()}
				nextMonthLabel={m.transactions_period_calendar_next_month()}
			/>
		</div>

		<div class="mt-3 border-t border-zinc-100 pt-2">
			<p class="mb-1 text-xs text-zinc-500">{m.transactions_period_custom_label()}</p>
			<!-- type="text" + inputmode="numeric", NEVER type="date": see isoToDisplay's docstring
				     above for why. The inputs must be genuinely, independently focusable text fields —
				     the reason this whole component exists as a sibling of FilterDropdown rather than a
				     mode on it, whose listbox options are deliberately never focusable. -->
			<!-- Wraps, and the two fields FLEX rather than carrying a fixed width. Both halves are
				     the fix for the same defect: the row was `flex items-end gap-2` holding two `w-28`
				     inputs plus `Appliquer`, needing 338px of a panel whose content box is 254px, so
				     the button painted 58px outside the panel's right border on every open.
				     Widening the panel instead was rejected — it would put the panel out of step with
				     FilterDropdown's 268px sibling and push it toward the viewport edge at 390. Here
				     the two fields share whatever row they are given and the action takes its own
				     line, which holds at any panel width without a second number to keep in sync. -->
			<div class="flex flex-wrap items-end gap-2">
				<div class="flex min-w-[6.5rem] flex-1 flex-col gap-0.5">
					<label for="{uid}-from" class="text-xs text-zinc-500">{m.reports_from_label()}</label>
					<input
						id="{uid}-from"
						bind:this={fromInputEl}
						type="text"
						inputmode="numeric"
						placeholder={datePlaceholder}
						class="h-9 w-full rounded-lg border border-zinc-200 px-2 text-sm tabular-nums focus:border-zinc-500 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
						bind:value={draftFromDisplay}
						oninput={() => {
							disarmPreset();
							lastEdited = 'from';
						}}
						onkeydown={onKeydown}
					/>
				</div>
				<div class="flex min-w-[6.5rem] flex-1 flex-col gap-0.5">
					<label for="{uid}-to" class="text-xs text-zinc-500">{m.reports_to_label()}</label>
					<input
						id="{uid}-to"
						type="text"
						inputmode="numeric"
						placeholder={datePlaceholder}
						class="h-9 w-full rounded-lg border border-zinc-200 px-2 text-sm tabular-nums focus:border-zinc-500 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
						bind:value={draftToDisplay}
						oninput={() => {
							disarmPreset();
							lastEdited = 'to';
						}}
						onkeydown={onKeydown}
					/>
				</div>
				<!--
						Apply is the SINGLE point of validation for all three writers, and that is the one
						place this dimension departs from the rest of the bar. Everywhere else, choosing a
						value applies it, because there is only one way to choose. Here there are three: a
						preset, the grid, the two fields. Applying on every write would mean a preset
						brushed by accident fires a request immediately, which then has to be undone by
						touching something else. With the button, a reader can pick the wrong preset,
						correct it on the grid, adjust it in a field, and nothing moves until they say so.

						`aria-disabled` on a still-focusable button rather than native `disabled`: the
						repo's rule for any inactive control that has to explain itself. A native
						`disabled` leaves the tab sequence, taking its own explanation out of reach of the
						keyboard user who most needs it.
					-->
				{#if surface !== 'mobile'}
					{@render actionRow()}
				{/if}
			</div>
		</div>

		{#if invalid}
			<p id={messageId} class="mt-2 text-xs text-zinc-600">
				{m.transactions_period_invalid_message()}
			</p>
		{/if}

		<!-- OUTSIDE any listbox, deliberately, same as FilterDropdown's own footer slot: a sibling
		     of the panel's controls, not one of them. -->
		{#if footer}
			<div data-testid="dd-footer">{@render footer()}</div>
		{/if}
	{/snippet}

	<!--
		The sheet's persistent header: the title, and the way back to "Filtres".

		Outside the scrolling body for exactly the reason the footer is — once the grid has been
		scrolled, a title and a return that scrolled away with it leave no visible exit. It was
		previously the first thing inside `children`, so it did scroll away, and the only remaining
		ways out were Escape, the backdrop and the swipe: three affordances a reader has to already
		know about. A sheet reached from the Filtres sheet must be able to say where it came from.
	-->
	{#snippet sheetHeader()}
		<div class="flex items-center gap-2">
			<button
				type="button"
				class="-ml-2 inline-flex min-h-11 min-w-11 items-center gap-1 rounded-lg px-2 text-sm text-zinc-600 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none"
				onclick={() => close({ restoreFocus: true })}
			>
				<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" class="h-4 w-4 shrink-0">
					<path
						d="M12 5.5 7.5 10l4.5 4.5"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
				{backLabel}
			</button>
			<h2 class="text-base font-semibold text-zinc-900">{dimensionLabel}</h2>
		</div>
	{/snippet}

	{#if open && surface === 'mobile'}
		<!--
			`aria-modal` comes from BottomSheet, which is correct here and NOT at 1280: at 390 the sheet
			occupies the screen, while the desktop panel is a non-modal dialog whose background stays
			clickable and where a click outside closes.

			The sheet also takes over Escape and focus restoration, so the popover's own
			`closeIfOutside` / `onFocusOut` mechanics deliberately do not run on this branch — two
			handlers for one dismissal is how this page previously ended up pushing two history entries
			for a single keystroke.
		-->
		<BottomSheet
			open={true}
			ariaLabel={dimensionLabel}
			onClose={() => close({ restoreFocus: true })}
			header={sheetHeader}
			footer={actionRow}
		>
			{@render panelBody()}
		</BottomSheet>
	{:else if open}
		<div
			bind:this={panelEl}
			id={panelId}
			role="dialog"
			tabindex={-1}
			aria-label={dimensionLabel}
			onkeydown={onKeydown}
			style:max-height={panelMaxHeight === null ? undefined : `${panelMaxHeight}px`}
			class="absolute top-full right-0 left-0 z-20 mt-1 min-w-[268px] overflow-y-auto rounded-xl border border-zinc-900 bg-white p-3"
		>
			{@render panelBody()}
		</div>
	{/if}
</div>
