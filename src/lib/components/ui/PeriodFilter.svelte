<script lang="ts" module>
	let idCounter = 0;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as m from '$lib/paraglide/messages';
	import Tooltip from './Tooltip.svelte';
	import { formatPeriodLabel, type PeriodCopy } from '$lib/domain/periodLabel';
	import {
		PERIOD_PRESET_IDS,
		matchPeriodPreset,
		periodPresetRange,
		type PeriodPresetId
	} from '$lib/domain/periodPresets';

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
		locale: string;
		todayIso: string;
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
	let draftFromDisplay = $state('');
	let draftToDisplay = $state('');

	/** Focus moves into the panel's first field on opening, mirroring FilterDropdown's own effect. */
	$effect(() => {
		if (!open) return;
		fromInputEl?.focus();
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
	const fullAriaLabel = $derived(`${dimensionLabel} : ${label.full}`);

	const selectedPreset = $derived(matchPeriodPreset({ from, to }, todayIso));

	const datePlaceholder = `${m.transactions_period_day_placeholder()}/${m.transactions_period_month_placeholder()}/${m.transactions_period_year_placeholder()}`;

	const PRESET_LABELS: Record<PeriodPresetId, () => string> = {
		thisMonth: m.transactions_period_preset_this_month,
		lastMonth: m.transactions_period_preset_last_month,
		last3Months: m.transactions_period_preset_last_3_months,
		last12Months: m.transactions_period_preset_last_12_months,
		thisYear: m.transactions_period_preset_this_year
	};

	/**
	 * `type="text"` + `inputmode="numeric"`, NEVER `type="date"`. The native date input renders
	 * jj/mm/aaaa or mm/dd/yyyy depending on the BROWSER's own locale and ignores every `lang`
	 * attribute this app sets — the same build showed two different formats on two machines. That is
	 * the exact defect this whole Période dimension exists to close, so these conversions render the
	 * app's own jj/mm/aaaa convention regardless of the visitor's browser.
	 */
	function isoToDisplay(iso: string): string {
		if (!iso) return '';
		const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
		if (!match) return iso;
		const [, y, mo, d] = match;
		return `${d}/${mo}/${y}`;
	}

	function displayToIso(display: string): string {
		const match = display.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
		if (!match) return display.trim();
		const [, d, mo, y] = match;
		return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
	}

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
		open = true;
	}

	function applyPreset(id: PeriodPresetId): void {
		const range = periodPresetRange(id, todayIso);
		close({ restoreFocus: true });
		onApply(range);
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
		const next = event.relatedTarget as Node | null;
		if (next === null) return;
		if (panelEl?.contains(next) || openButtonEl?.contains(next)) return;
		close({ restoreFocus: false });
	}

	function closeIfOutside(event: MouseEvent): void {
		if (!open) return;
		const target = event.target as Node | null;
		if (!target) return;
		if (panelEl?.contains(target) || openButtonEl?.contains(target)) return;
		close({ restoreFocus: false });
	}
</script>

<svelte:window onclick={closeIfOutside} />

<div class="relative inline-block" onfocusout={onFocusOut}>
	<!-- Mirrors FilterDropdown's trigger group exactly: 34px desktop / 36px mobile, overflow-hidden
	     rounded-xl border, and (when active) two ADJOINED buttons rather than one nested inside the
	     other (nested buttons are invalid HTML). Mobile additionally grows each button's TAP area to
	     44px via `min-h-[44px] -my-1` — transparent overflow, so the 36px visual row never grows —
	     the same pattern design section 7 uses for the regex toggle at 390. -->
	{#snippet triggerGroup()}
		<div
			data-testid="period-trigger-group"
			class="inline-flex items-stretch overflow-hidden rounded-xl border {surface === 'mobile'
				? 'h-9'
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
					? '-my-1 min-h-[44px]'
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
					class="inline-flex min-w-[24px] items-center justify-center px-2.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none {surface ===
					'mobile'
						? '-my-1 min-h-[44px]'
						: ''}"
					aria-label={clearAriaLabel}
					onclick={clearAll}
				>
					<span aria-hidden="true">×</span>
				</button>
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

	{#if open}
		<div
			bind:this={panelEl}
			id={panelId}
			role="dialog"
			aria-label={dimensionLabel}
			class="absolute top-full right-0 left-0 z-20 mt-1 max-h-[70vh] min-w-[280px] overflow-y-auto rounded-xl border border-zinc-900 bg-white p-3"
		>
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
				     otherwise. -->
				<div class="flex flex-wrap gap-1.5">
					{#each PERIOD_PRESET_IDS as id (id)}
						<button
							type="button"
							aria-pressed={selectedPreset === id}
							class="rounded-lg border px-2.5 py-1.5 text-sm {selectedPreset === id
								? 'border-zinc-900 bg-zinc-100'
								: 'border-zinc-200 bg-white hover:bg-zinc-50'}"
							onclick={() => applyPreset(id)}
						>
							{PRESET_LABELS[id]()}
						</button>
					{/each}
				</div>
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
					<div class="flex min-w-[7rem] flex-1 flex-col gap-0.5">
						<label for="{uid}-from" class="text-xs text-zinc-500">{m.reports_from_label()}</label>
						<input
							id="{uid}-from"
							bind:this={fromInputEl}
							type="text"
							inputmode="numeric"
							placeholder={datePlaceholder}
							class="h-9 w-full rounded-lg border border-zinc-200 px-2 text-sm tabular-nums focus:border-zinc-500 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
							bind:value={draftFromDisplay}
							onkeydown={onKeydown}
						/>
					</div>
					<div class="flex min-w-[7rem] flex-1 flex-col gap-0.5">
						<label for="{uid}-to" class="text-xs text-zinc-500">{m.reports_to_label()}</label>
						<input
							id="{uid}-to"
							type="text"
							inputmode="numeric"
							placeholder={datePlaceholder}
							class="h-9 w-full rounded-lg border border-zinc-200 px-2 text-sm tabular-nums focus:border-zinc-500 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
							bind:value={draftToDisplay}
							onkeydown={onKeydown}
						/>
					</div>
					<button
						type="button"
						class="h-9 w-full rounded-lg border border-zinc-900 bg-zinc-900 px-3 text-sm text-white hover:bg-zinc-700"
						onclick={applyDraft}
					>
						{m.transactions_period_apply()}
					</button>
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
		</div>
	{/if}
</div>
