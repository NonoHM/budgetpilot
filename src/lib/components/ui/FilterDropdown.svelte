<script lang="ts" module>
	export interface FilterDropdownOption {
		value: string;
		label: string;
		/** null means "the server could not answer", which is NOT the same as 0. */
		count?: number | null;
		/** A zero count in scope: reachable by the arrows so it is announced, never activable. */
		disabled?: boolean;
		/** Tailwind background class for the 8px dot. Omit for a dimension with no colour. */
		swatchClass?: string;
	}

	let idCounter = 0;

	/** Past this many options the panel grows an internal search field. */
	const SEARCH_THRESHOLD = 8;

	/** Not a zero: zero is a value, this says "unknown". Mirrors the totals region's placeholder. */
	const COUNT_UNKNOWN = '—';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as m from '$lib/paraglide/messages';

	/**
	 * A filter trigger and its listbox panel, for one dimension of the /transactions filter bar.
	 *
	 * THE RULE THIS COMPONENT EXISTS TO ENFORCE (design section 4): at rest a trigger carries the
	 * name of its DIMENSION and nothing else; active, it carries "Dimension : Valeur". "Toutes" is
	 * the resting value of a filter, and a trigger displaying its value is the direct cause of the
	 * two adjacent "Toutes" this grammar removes. "Toutes" survives only as the return row inside
	 * the open list. Two dimensions can therefore never render the same text, by construction.
	 *
	 * Why this is not built on an existing brick, recorded so it is not "simplified" later:
	 *  - ui/DropdownMenu.svelte is a bits-ui wrapper around role="menu"/menuitem. This is a listbox.
	 *  - bits-ui Select puts role="listbox" on the content element itself, so the footer row would
	 *    become an illegal child of the listbox — and the design is explicit that the footer is a
	 *    sibling, "pas une option", excluded from "3 éléments".
	 * The keyboard model is TagPicker's, deliberately: clamped arrows (no wrap-around), managed
	 * focus via aria-activedescendant with options never independently focusable, and Escape
	 * stopPropagation()-ed ONLY when the panel is open.
	 *
	 * The panel is ABSOLUTELY POSITIONED, and that is load-bearing rather than stylistic. An
	 * in-flow panel is what silently ate a first-time user's first save for the whole tags
	 * chantier: pressing the mouse on a control below moved focus out, focusout closed the panel,
	 * everything under it jumped up (measured 114px, against a 32px-tall button) and the mouse-up
	 * landed on whatever had slid underneath, so no click was ever emitted. See the long comment at
	 * TagPicker.svelte:131 before changing this.
	 */
	let {
		dimensionLabel,
		activeLabel = undefined,
		options,
		value,
		allLabel,
		allCount = undefined,
		scopeNote = undefined,
		searchPlaceholder,
		countsLoading = false,
		clearAriaLabel,
		tinted = false,
		tintBgClass = '',
		tintBorderClass = '',
		onSelect,
		onClear,
		footer
	}: {
		dimensionLabel: string;
		/**
		 * The active trigger's accessible name, already formatted by the caller as
		 * "Dimension : Valeur". It is a prop rather than composed here because the separator is
		 * copy: French puts a space before the colon and English does not. The visible text is
		 * rendered in three spans instead of this one string only so the VALUE can truncate while
		 * the dimension name never does — same data, one authority for the name.
		 */
		activeLabel?: string;
		options: FilterDropdownOption[];
		value: string;
		allLabel: string;
		allCount?: number | null;
		scopeNote?: string;
		searchPlaceholder: string;
		countsLoading?: boolean;
		clearAriaLabel: string;
		tinted?: boolean;
		tintBgClass?: string;
		tintBorderClass?: string;
		onSelect: (value: string) => void;
		onClear: () => void;
		footer?: Snippet;
	} = $props();

	idCounter += 1;
	const uid = `filter-dd-${idCounter}`;
	const listboxId = `${uid}-listbox`;

	let open = $state(false);
	let typed = $state('');
	let activeIndex = $state(-1);
	let openButtonEl = $state<HTMLButtonElement | null>(null);
	let panelEl = $state<HTMLDivElement | null>(null);
	let listEl = $state<HTMLUListElement | null>(null);
	let searchEl = $state<HTMLInputElement | null>(null);

	/**
	 * Focus moves INTO the panel on opening, onto the search field when there is one and onto the
	 * listbox itself otherwise. That is what makes aria-activedescendant legal: the attribute has
	 * to sit on the focused element, and neither a <button> nor a bare <input> supports it.
	 * Escape returns focus to the trigger, which is the design's "Échap ferme et rend le focus".
	 */
	$effect(() => {
		if (!open) return;
		(showSearch ? searchEl : listEl)?.focus();
	});

	const selectedOption = $derived(options.find((o) => o.value === value) ?? null);

	/**
	 * Active means BOTH: a value is set and it names an option we can actually display.
	 *
	 * The two halves used to be tested separately — the label on `value && selectedOption`, the
	 * black border and the "×" on `value` alone — and a `value` naming an option that is not in
	 * `options` then rendered a trigger that read as resting while painting itself active, with an
	 * orphan "×" beside it. That is reachable in this app rather than theoretical: a tag on zero
	 * transactions is deleted silently, so a bookmarked or back-buttoned `?tag=<id>` routinely
	 * outlives its tag.
	 *
	 * Rendering it as resting is the honest answer — there is no value to name — and it does not
	 * strand anyone: the stale conjunct still matches nothing server-side, so the summary row's
	 * "Réinitialiser les filtres" is rendered and is the way out. The caller additionally scrubs an
	 * unknown id before it reaches here; this is the second line of defence, not the first.
	 */
	const isActive = $derived(value !== '' && selectedOption !== null);

	/**
	 * The search field appears past 8 options and REPLACES the scope line, never sits beside it:
	 * two header lines would push the first tag to the third row of the panel.
	 */
	const showSearch = $derived(options.length > SEARCH_THRESHOLD);

	const filtered = $derived(
		typed.trim() === ''
			? options
			: options.filter((o) => o.label.toLowerCase().includes(typed.trim().toLowerCase()))
	);

	/** The return row is not conditional: it is there even with a single option. */
	type Row = { kind: 'all' } | { kind: 'option'; option: FilterDropdownOption };

	const rows = $derived<Row[]>([
		{ kind: 'all' },
		...filtered.map((option) => ({ kind: 'option' as const, option }))
	]);

	const activeId = $derived(activeIndex >= 0 ? `${uid}-row-${activeIndex}` : undefined);

	function rowDisabled(row: Row): boolean {
		return row.kind === 'option' && row.option.disabled === true;
	}

	function activate(index: number): void {
		const row = rows[index];
		if (!row || rowDisabled(row)) return;
		close({ restoreFocus: true });
		onSelect(row.kind === 'all' ? '' : row.option.value);
	}

	function close({ restoreFocus }: { restoreFocus: boolean }): void {
		open = false;
		activeIndex = -1;
		typed = '';
		// The design is explicit: focus returns to the button that opened the menu, and when the
		// selection has just made the trigger active it returns to the OPEN button of the group,
		// never to the "×". Landing on a clear control is one keystroke from undoing the choice
		// that was just made.
		if (restoreFocus) openButtonEl?.focus();
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			open = true;
			// Clamped, not modulo: wrapping past the end silently moves the user to the other end
			// of a list they cannot see all of.
			activeIndex = Math.min(activeIndex + 1, rows.length - 1);
		} else if (event.key === 'ArrowUp') {
			// Guarded on `open`, unlike ArrowDown which opens. Moving the cursor inside a closed
			// panel is invisible, and the next ArrowDown then opens on the SECOND row rather than
			// the first, with nothing having said why.
			if (!open) return;
			event.preventDefault();
			activeIndex = Math.max(activeIndex - 1, 0);
		} else if (event.key === 'Home') {
			if (!open) return;
			event.preventDefault();
			activeIndex = 0;
		} else if (event.key === 'End') {
			if (!open) return;
			event.preventDefault();
			activeIndex = rows.length - 1;
		} else if (event.key === 'Enter' || event.key === ' ') {
			if (!open) {
				event.preventDefault();
				open = true;
				return;
			}
			event.preventDefault();
			if (activeIndex === -1 && rows.length > 0) activeIndex = 0;
			activate(activeIndex);
		} else if (event.key === 'Escape') {
			// Conditional on `open`, exactly as TagPicker's is, and for the same reason: with the
			// panel closed this component has nothing to dismiss, and swallowing the key would
			// break the detail panel's own Escape, which predates tags. Unconditional
			// stopPropagation here is what makes one Escape close two things.
			if (open) {
				event.stopPropagation();
				close({ restoreFocus: true });
			}
		}
	}

	/**
	 * Tabbing out of the panel closes it.
	 *
	 * Without this the panel is a keyboard trap in reverse: the <ul> is tabindex="-1", so it is
	 * focusable programmatically but absent from the Tab sequence, and one Tab moves focus to the
	 * footer link or past the component entirely while `open` stays true. The panel then floats
	 * over the page with no way back — Escape is bound to the search field and the listbox, so it
	 * no longer reaches anything, and only an unrelated mouse click elsewhere dismisses it.
	 * TagPicker already carries this mechanism (onfocusout -> closeIfOutside); it was simply not
	 * carried over with the rest of the pattern.
	 */
	function onFocusOut(event: FocusEvent): void {
		if (!open) return;
		const next = event.relatedTarget as Node | null;
		// relatedTarget null means focus left the document entirely (another window, the browser
		// chrome): the panel should stay as it is rather than close behind the user's back.
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

	function countText(count: number | null | undefined): string {
		if (countsLoading) return '';
		if (count === null || count === undefined) return COUNT_UNKNOWN;
		return String(count);
	}
</script>

<svelte:window onclick={closeIfOutside} />

<div class="relative inline-block" onfocusout={onFocusOut}>
	<!-- Active is a GROUP OF TWO ADJOINED BUTTONS, never one button nested in another (invalid
	     HTML) and never a single control doing both jobs: the design requires two targets of at
	     least 24px, so the filter can be re-chosen without clearing it first. -->
	<div
		class="inline-flex h-11 items-stretch overflow-hidden rounded-xl border {isActive
			? tinted
				? `${tintBgClass} ${tintBorderClass}`
				: 'border-zinc-900 bg-white'
			: 'border-zinc-200 bg-white'}"
	>
		<button
			bind:this={openButtonEl}
			type="button"
			aria-haspopup="listbox"
			aria-expanded={open}
			aria-controls={open ? listboxId : undefined}
			aria-label={isActive && activeLabel ? activeLabel : undefined}
			class="inline-flex min-w-[24px] items-center gap-1.5 px-3 text-sm text-zinc-900 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none"
			onclick={() => (open ? close({ restoreFocus: false }) : (open = true))}
			onkeydown={onKeydown}
		>
			{#if selectedOption?.swatchClass}
				<span class="h-2 w-2 shrink-0 rounded-full {selectedOption.swatchClass}"></span>
			{/if}
			{#if isActive && selectedOption}
				<!-- The dimension name NEVER truncates; the value does, capped at 190px. -->
				<span class="whitespace-nowrap">{dimensionLabel}</span>
				<span aria-hidden="true">:</span>
				<span class="max-w-[190px] truncate">{selectedOption.label}</span>
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
				class="inline-flex min-w-[24px] items-center justify-center px-2.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none"
				aria-label={clearAriaLabel}
				onclick={onClear}
			>
				<span aria-hidden="true">×</span>
			</button>
		{/if}
	</div>

	{#if open}
		<div
			bind:this={panelEl}
			class="absolute top-full right-0 left-0 z-20 mt-1 min-w-[268px] rounded-xl border border-zinc-900 bg-white"
		>
			{#if showSearch}
				<div class="border-b border-zinc-100 p-1.5">
					<!-- role="combobox" is what makes aria-activedescendant legal here. It is not
					     decoration: a plain <input> does not support the attribute, and neither does
					     the <button> trigger — svelte-check rejects it on both. The focused element
					     is whichever of these two the panel opened with, and it is the one that
					     carries the active row. -->
					<input
						bind:this={searchEl}
						type="text"
						role="combobox"
						aria-expanded="true"
						aria-controls={listboxId}
						aria-activedescendant={activeId}
						aria-autocomplete="list"
						class="h-9 w-full rounded-lg border border-zinc-200 bg-white px-2.5 text-sm focus:border-zinc-500 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
						placeholder={searchPlaceholder}
						aria-label={searchPlaceholder}
						bind:value={typed}
						oninput={() => (activeIndex = -1)}
						onkeydown={onKeydown}
					/>
				</div>
			{:else if scopeNote}
				<!-- The scope is named in one line at the head of the panel. Without it a zero count
				     is incomprehensible: the reader cannot tell "no such transaction" from "not in
				     this filter". -->
				<p class="border-b border-zinc-100 px-3 py-2 text-xs text-zinc-500">{scopeNote}</p>
			{/if}

			<ul
				bind:this={listEl}
				id={listboxId}
				role="listbox"
				tabindex="-1"
				aria-label={dimensionLabel}
				aria-activedescendant={showSearch ? undefined : activeId}
				class="max-h-[280px] overflow-y-auto p-1 focus:outline-none"
				onkeydown={onKeydown}
			>
				{#each rows as row, index (row.kind === 'all' ? '__all__' : row.option.value)}
					{@const disabled = rowDisabled(row)}
					<!-- Keyboard interaction is handled entirely at the trigger via aria-activedescendant
					     (a managed-focus listbox, WAI-ARIA APG "Collection with aria-activedescendant"):
					     these rows are never independently focusable, so no keydown handler applies
					     here. Same pattern, and same suppression, as TagPicker's option rows. -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<li
						id="{uid}-row-{index}"
						role="option"
						aria-selected={row.kind === 'all' ? value === '' : row.option.value === value}
						aria-disabled={disabled ? 'true' : undefined}
						class="flex h-[34px] cursor-pointer items-center justify-between gap-2 rounded px-2.5 text-sm {index ===
						activeIndex
							? 'bg-zinc-100'
							: ''} {disabled ? 'cursor-not-allowed text-zinc-400' : 'text-zinc-700'} {row.kind ===
						'all'
							? 'mb-1 border-b border-zinc-100 pb-1'
							: ''}"
						onmousedown={(event) => event.preventDefault()}
						onclick={() => activate(index)}
						onmouseenter={() => (activeIndex = index)}
					>
						<span class="flex min-w-0 items-center gap-2">
							{#if row.kind === 'option' && row.option.swatchClass}
								<span class="h-2 w-2 shrink-0 rounded-full {row.option.swatchClass}"></span>
							{/if}
							<span class="truncate">{row.kind === 'all' ? allLabel : row.option.label}</span>
							{#if row.kind === 'option' && row.option.value === value}
								<!-- A check, not merely a zinc-100 background: a background alone is
								     information carried by colour. -->
								<svg
									class="h-3.5 w-3.5 shrink-0 text-zinc-500"
									viewBox="0 0 16 16"
									fill="none"
									aria-hidden="true"
								>
									<path
										d="M2.5 8 6.5 12 13.5 4"
										stroke="currentColor"
										stroke-width="1.6"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
								</svg>
							{/if}
						</span>
						<span class="shrink-0 text-xs text-zinc-500 tabular-nums">
							{countText(row.kind === 'all' ? allCount : row.option.count)}
						</span>
					</li>
				{/each}
			</ul>

			{#if countsLoading}
				<p class="sr-only" role="status">{m.tags_picker_loading_aria()}</p>
			{/if}

			<!-- OUTSIDE the listbox, deliberately: a sibling, not an option. It must not be counted
			     into "3 éléments" and the arrows must never reach it — Tab does. -->
			{#if footer}
				<div data-testid="dd-footer">{@render footer()}</div>
			{/if}
		</div>
	{/if}
</div>
