<script module lang="ts">
	let idCounter = 0;
</script>

<script lang="ts">
	import type { TagColorToken } from '$lib/domain/tags';
	import { MAX_TAGS_PER_TRANSACTION, normalizeTagName } from '$lib/domain/tags';
	import { highlightMatchSegments, normalizeForMatch } from '$lib/domain/normalize';
	import { tagColorBgClass } from '$lib/domain/colors';
	import { inputBase } from '$lib/styles';
	import TagChips from './TagChips.svelte';
	import ManageTagsFooter from './ManageTagsFooter.svelte';
	import * as m from '$lib/paraglide/messages';

	/**
	 * Multi-select tag combobox with an inline "create" affordance, built directly on ARIA's
	 * combobox+listbox pattern rather than wrapping ui/Combobox.svelte.
	 *
	 * Not bits-ui's Combobox (which ui/Combobox.svelte already wraps): that component is
	 * `type="single"` throughout this codebase, and its zero-result branch is a non-interactive
	 * `<p>` (Combobox.svelte:104-107) — exactly where a create row must go. Rather than fork a
	 * `type="multiple"` variant around a dynamically-injected, not-yet-real item value (the create
	 * row), this stays a small self-contained combobox: every ARIA relationship the design
	 * requires (role=combobox/listbox/option, aria-activedescendant, aria-multiselectable) is
	 * hand-wired here and directly testable, rather than trusted to a third-party integration this
	 * codebase has not exercised for the "select OR create" shape before.
	 *
	 * Selected chips render ABOVE the field (never inside it): a growing field would break the
	 * shared 44px field template (inputBase) and reflow the page on every keystroke.
	 */
	export interface TagPickerOption {
		id: string;
		name: string;
		colorToken: TagColorToken;
	}

	let {
		options,
		selected = $bindable([]),
		name,
		ariaLabel,
		disabled = false,
		loading = false
	}: {
		options: TagPickerOption[];
		/** Tag NAMES, not ids — this picker can select a tag that already exists and create one
		 *  that does not, and only names let the server resolve both through the same
		 *  resolveTagByName call with no branch for "existing" vs "new". */
		selected: string[];
		/** Hidden input name for a surrounding POST form; newline-separated (never comma: a tag
		 *  name may legitimately contain one, and '\n' cannot survive normalizeTagName's whitespace
		 *  collapse, so it stays unambiguous). No hidden input is rendered when omitted. */
		name?: string;
		ariaLabel?: string;
		disabled?: boolean;
		/** Extension beyond the plan's own interface, per the design's state G ("Chargement de la
		 *  liste"): the field stays typeable while the option list is still loading, and the panel
		 *  shows phantom rows instead of a spinner overlay. Purely additive; every existing caller
		 *  that omits it keeps today's behaviour. */
		loading?: boolean;
	} = $props();

	// eslint-disable-next-line no-useless-assignment
	const pickerId = `tag-picker-${idCounter++}`;
	const inputId = `${pickerId}-input`;
	const listboxId = `${pickerId}-listbox`;

	let open = $state(false);
	let typed = $state('');
	let debounced = $state('');
	let activeIndex = $state(-1);
	let liveAnnouncement = $state('');
	let inputEl: HTMLInputElement | undefined;
	let containerEl: HTMLDivElement | undefined;

	// Live filtering is debounced 250ms (per design brique 14 timing) rather than filtering on
	// every keystroke.
	$effect(() => {
		const value = typed;
		const timer = setTimeout(() => {
			debounced = value;
		}, 250);
		return () => clearTimeout(timer);
	});

	const trimmedTyped = $derived(debounced.trim());
	const normalizedTyped = $derived(normalizeForMatch(trimmedTyped));

	// Every option matching the search, selected or not: the design shows a selected option in the
	// list too, with a checkmark, so re-clicking it removes it (state E) instead of hiding it.
	const filtered = $derived(
		trimmedTyped === ''
			? options
			: options.filter((o) => normalizeForMatch(o.name).includes(normalizedTyped))
	);

	const createNameDebounced = $derived(normalizeTagName(debounced));

	// The create row only ever appears with no match at all, and never for an already-selected
	// name (typing the exact name of a tag already picked must not offer to "create" it again).
	const showCreateRow = $derived(
		createNameDebounced !== '' &&
			filtered.length === 0 &&
			!selected.some((n) => normalizeForMatch(n) === normalizeForMatch(createNameDebounced))
	);

	type FlatItem = { type: 'option'; option: TagPickerOption } | { type: 'create'; rawName: string };

	const flatItems = $derived<FlatItem[]>([
		...filtered.map((option) => ({ type: 'option' as const, option })),
		...(showCreateRow ? [{ type: 'create' as const, rawName: createNameDebounced }] : [])
	]);

	const atMax = $derived(selected.length >= MAX_TAGS_PER_TRANSACTION);

	// Display-only: pre-highlights item 0 (state D's "Créer" row when it is the only item) before
	// any explicit ArrowUp/ArrowDown/Enter, so the row Enter would act on is visible beforehand
	// rather than only after Enter has already fired. Kept separate from `activeIndex` itself so
	// the -1 "nothing chosen yet" state Enter/ArrowUp/ArrowDown already rely on is untouched.
	const effectiveActiveIndex = $derived(
		activeIndex === -1 && flatItems.length > 0 ? 0 : activeIndex
	);

	const chips = $derived(
		selected.map((tagName) => ({
			key: tagName,
			name: tagName,
			colorToken: options.find((o) => o.name === tagName)?.colorToken ?? null
		}))
	);

	/**
	 * Called when a tag has just been ADDED — never when one is deselected, which leaves the panel
	 * open so a mis-click is undone on the spot.
	 *
	 * Closing here is half of the fix for a defect that silently ate a first-time user's first save,
	 * and it only makes sense together with the panel being detached (see its own comment below).
	 * The two are a pair:
	 *
	 *  - In the layout flow, the panel pushed Save down. Pressing the mouse on Save moved focus out
	 *    of the field, `onFocusOut` closed the panel, everything below it jumped up (measured: 114px,
	 *    against a button 32px tall) and the mouse came back up on whatever had slid underneath. No
	 *    `click` was emitted, the form never submitted, and the tag the user had just typed stayed
	 *    unsaved. A second click worked, which is what makes it read as a mis-click, not a bug.
	 *  - Detached but left open, the panel stops moving anything, but it now sits ON TOP of Save, and
	 *    a click on the panel does not dismiss it (closeIfOutside rightly ignores its own subtree),
	 *    so Save is unreachable until the user happens to click some third place.
	 *
	 * Detached AND closed on commit, neither happens: by the time the user reaches for Save the panel
	 * is gone, and nothing has moved. Reopening costs one keystroke or one click on the field, so
	 * picking several tags in a row still never sends the user outside it, and the design's "le focus
	 * reste dans le champ pour enchaîner" holds — focus does not leave the input here.
	 */
	function commitSelection(): void {
		typed = '';
		debounced = '';
		activeIndex = -1;
		open = false;
	}

	function addName(tagName: string): void {
		if (atMax || selected.includes(tagName)) return;
		selected = [...selected, tagName];
	}

	function toggleOption(option: TagPickerOption): void {
		if (selected.includes(option.name)) {
			selected = selected.filter((n) => n !== option.name);
			announceRemoved(option.name);
			return;
		}
		if (atMax) return;
		addName(option.name);
		liveAnnouncement = m.tags_picker_added_live({ name: option.name });
		commitSelection();
	}

	function createOrSelect(rawName: string): void {
		if (atMax) return;
		const finalName = normalizeTagName(rawName);
		if (finalName === '') return;
		const existing = options.find(
			(o) => normalizeForMatch(o.name) === normalizeForMatch(finalName)
		);
		if (existing) {
			addName(existing.name);
			liveAnnouncement = m.tags_picker_selected_live({ name: existing.name });
		} else {
			addName(finalName);
			liveAnnouncement = m.tags_picker_created_live({ name: finalName });
		}
		commitSelection();
	}

	/**
	 * The removal's own sentence, into the SAME region the additions use.
	 *
	 * Not a second live region: two regions competing over one selection is how a screen reader
	 * ends up hearing the wrong half. And not silence, which is what this was: a polite region is
	 * only read when its content CHANGES, so a removal that announced nothing left « {name}
	 * ajoutée » standing — a reader arriving there was told the opposite of what had just happened.
	 *
	 * Both removal paths call it, because there are two and they are easy to fix one at a time:
	 * the chip's own ✕, and re-clicking an already-selected row in the panel.
	 */
	function announceRemoved(tagName: string): void {
		liveAnnouncement = m.tags_picker_removed_live({ name: tagName });
	}

	function removeChip(tagName: string): void {
		selected = selected.filter((n) => n !== tagName);
		announceRemoved(tagName);
	}

	function activate(index: number): void {
		const item = flatItems[index];
		if (!item) return;
		if (item.type === 'option') toggleOption(item.option);
		else createOrSelect(item.rawName);
	}

	function onInput(event: Event): void {
		typed = (event.currentTarget as HTMLInputElement).value;
		open = true;
		activeIndex = -1;
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			open = true;
			activeIndex = Math.min(activeIndex + 1, flatItems.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			activeIndex = Math.max(activeIndex - 1, 0);
		} else if (event.key === 'Enter') {
			// Gated on `open`: Escape leaves `typed`/`debounced` (and therefore `flatItems`) intact
			// so it can close without discarding the in-progress search, but that means an Enter
			// pressed after Escape must be inert rather than silently activating item 0.
			if (!open) return;
			event.preventDefault();
			if (activeIndex === -1 && flatItems.length > 0) activeIndex = 0;
			activate(activeIndex);
		} else if (event.key === 'Escape') {
			// Only when this Escape had something to close. Without the guard the keystroke kept
			// bubbling to whatever page-level handler sits behind the picker — on /transactions that
			// is BottomSheet's window keydown, mounted at every breakpoint and hidden only by CSS,
			// which closes the transaction detail panel. One Escape therefore closed the picker AND
			// deselected the transaction, discarding any unsaved tag edits with no confirmation.
			// The design assigns Escape a single job here ("Échap ferme sans changer la sélection").
			//
			// Deliberately NOT unconditional: with the panel already closed this component has
			// nothing to dismiss, and swallowing the key would break the detail panel's own Escape,
			// which works from every other control in it and predates tags.
			if (open) {
				event.stopPropagation();
				open = false;
				activeIndex = -1;
			}
		} else if (event.key === 'Backspace' && typed === '' && selected.length > 0) {
			selected = selected.slice(0, -1);
		}
	}

	const activeId = $derived(
		effectiveActiveIndex >= 0 ? `${pickerId}-option-${effectiveActiveIndex}` : undefined
	);

	const resultCountLive = $derived.by(() => {
		if (!open) return '';
		if (filtered.length > 0) {
			return filtered.length === 1
				? m.tags_picker_result_count_one({ n: filtered.length })
				: m.tags_picker_result_count_many({ n: filtered.length });
		}
		if (showCreateRow) return m.tags_picker_no_match_live();
		// filtered.length === 0 && !showCreateRow: either nothing has been typed yet, or the typed
		// name matches an already-selected tag exactly — Enter is a genuine no-op in the latter
		// case, so this must not reuse the "Entrée pour créer" wording above.
		if (trimmedTyped !== '') return m.tags_picker_already_selected_live({ name: trimmedTyped });
		return '';
	});

	function closeIfOutside(target: EventTarget | null): void {
		if (!open) return;
		// A click on the "Créer" row lands here rather than in the branch above, and closes the panel:
		// creating the tag re-renders the panel without that row, so the node the click fired on is
		// already detached by the time this runs and cannot be tested for containment. That is left
		// as it is — closing after creating a tag is reasonable on its own terms, and the alternative
		// (treating any detached target as inside) means guessing about nodes this component may not
		// own. Selecting an option that already exists keeps the panel open, since that row stays
		// mounted.
		if (target instanceof Node && containerEl?.contains(target)) return;
		open = false;
		activeIndex = -1;
	}

	function onFocusOut(event: FocusEvent): void {
		// relatedTarget is the element about to receive focus (null when focus leaves the document
		// entirely, e.g. a browser chrome control) — options themselves call preventDefault() on
		// their own mousedown, so a click on an option never reaches here in the first place.
		closeIfOutside(event.relatedTarget);
	}

	/**
	 * `click`, NOT `pointerdown`, and that difference is the whole bug this used to have.
	 *
	 * The panel sits in the layout flow, so closing it moves everything below it upward. On
	 * `pointerdown` that happened BETWEEN the user's mouse-down and mouse-up: pressing on the Save
	 * button below the picker closed the panel, the button jumped up (measured: 99px, against a
	 * button 32px tall), the mouse-up landed on whatever had slid underneath, and no `click` event
	 * was ever emitted. The first click on Save did nothing at all — silently, with the tag the user
	 * had just typed still unsaved. The second click worked, which is what makes it read as a
	 * mis-click rather than a bug. It was found by using the app, not by a test: the e2e suite had
	 * been taught to dismiss the panel first, so it never clicked Save the way a user does.
	 *
	 * A `click` listener fires only once the press and the release have landed on the same element,
	 * so the target's own handlers have already run by the time anything reflows. Everything else is
	 * unchanged: closeIfOutside still ignores clicks inside the picker, and focusout still closes
	 * the panel when focus moves to a focusable element elsewhere.
	 */
	$effect(() => {
		if (!open) return;
		function onDocumentClick(event: MouseEvent): void {
			closeIfOutside(event.target);
		}
		document.addEventListener('click', onDocumentClick);
		return () => document.removeEventListener('click', onDocumentClick);
	});
</script>

<!-- `relative` is the containing block the detached panel below positions against; without it the
     panel would attach to some ancestor and stop tracking the field. -->
<div class="relative w-full" bind:this={containerEl} onfocusout={onFocusOut}>
	<label class="sr-only" for={inputId}>{ariaLabel ?? m.tags_picker_aria()}</label>

	{#if chips.length > 0}
		<div class="mb-2">
			<TagChips tags={chips} variant="enclosed" max={Infinity} onRemove={removeChip} />
		</div>
	{/if}

	<div class="relative">
		<span
			class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-zinc-400"
			aria-hidden="true"
		>
			+
		</span>
		<!-- onfocus AND onclick, neither redundant: `focus` does not fire on a field that already has
		     it, which is exactly where the user stands right after committing a tag — panel closed,
		     caret still in the field. Without the click handler, clicking the field to see the list
		     again would do nothing at all and the only way back would be to type. -->
		<input
			bind:this={inputEl}
			id={inputId}
			role="combobox"
			class="{inputBase} w-full pl-7"
			type="text"
			autocomplete="off"
			value={typed}
			{disabled}
			placeholder={m.tags_picker_placeholder()}
			aria-expanded={open}
			aria-controls={listboxId}
			aria-autocomplete="list"
			aria-activedescendant={activeId}
			oninput={onInput}
			onfocus={() => (open = true)}
			onclick={() => (open = true)}
			onkeydown={onKeydown}
		/>
	</div>

	{#if name}
		<input type="hidden" {name} value={selected.join('\n')} />
	{/if}

	<div class="sr-only" role="status" aria-live="polite">{resultCountLive}</div>
	<div class="sr-only" role="status" aria-live="polite">{liveAnnouncement}</div>

	{#if open}
		<!-- Option rows are 48px on mobile and 36px from `sm` up, the design's own figures ("items
		     36 px desktop / 48 px mobile"). Pinned rather than left to padding + line-height, which
		     gave 32px at BOTH breakpoints — under the 44px minimum the design sets for every mobile
		     target, and measured in a browser rather than read off the class list.
		     DETACHED, and this is load-bearing rather than styling: an in-flow panel moves every
		     control below it each time it opens or closes, and closing happens on focusout — which
		     fires on the mouse-down of the very click the user is making on Save. See
		     commitSelection() above for the full account and the measurement. Positioned against the
		     container's bottom edge, which is the input's: chips sit above it, and the hidden input
		     and the two sr-only live regions take no layout space. -->
		<div
			id={listboxId}
			class="absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-xl border border-zinc-900 bg-white shadow-lg"
		>
			<!-- The scroll lives on this inner wrapper rather than on the panel, so the footer below
			     stays pinned to the bottom of the panel instead of scrolling away under a long list.
			     Same reason the mobile sheet keeps its footer out of the scrolling list. -->
			<div class="max-h-[280px] overflow-y-auto p-1.5">
				{#if loading}
					<ul class="space-y-1" role="status" aria-label={m.tags_picker_loading_aria()}>
						{#each { length: 3 } as _, i (i)}
							<li class="flex items-center gap-2 rounded-lg px-2 py-1.5">
								<span class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-zinc-200"></span>
								<span class="h-2.5 w-24 animate-pulse rounded bg-zinc-200"></span>
							</li>
						{/each}
					</ul>
				{:else if options.length === 0 && trimmedTyped === ''}
					<div class="space-y-1 px-2 py-2">
						<p class="text-sm text-zinc-700">{m.tags_picker_empty_heading()}</p>
						<p class="text-[12.5px] text-zinc-500">{m.tags_picker_empty_body()}</p>
					</div>
				{:else if flatItems.length === 0}
					<!-- filtered.length === 0 and no create row: the typed name exactly matches a tag
				     that's already selected, so there is genuinely nothing left to show and Enter is
				     a no-op — an EMPTY <ul role="listbox"> here would render as a blank floating panel
				     instead of explaining that. -->
					<p class="px-2 py-2 text-sm text-zinc-700">
						{m.tags_picker_already_selected_live({ name: trimmedTyped })}
					</p>
				{:else}
					<ul role="listbox" aria-multiselectable="true">
						{#each flatItems as item, index (item.type === 'option' ? item.option.id : 'create')}
							{@const isActive = index === effectiveActiveIndex}
							{#if item.type === 'option'}
								{@const isSelected = selected.includes(item.option.name)}
								<!-- Keyboard interaction is fully handled at the input via aria-activedescendant
							     (a managed-focus listbox, WAI-ARIA APG "Collection with aria-activedescendant"):
							     these items are never independently focusable, so no keydown handler applies here. -->
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<li
									id="{pickerId}-option-{index}"
									role="option"
									aria-selected={isSelected}
									class="flex h-12 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm text-zinc-700 sm:h-9 {isActive
										? 'bg-zinc-100'
										: ''}"
									onmousedown={(event) => event.preventDefault()}
									onclick={() => toggleOption(item.option)}
									onmouseenter={() => (activeIndex = index)}
								>
									<span
										class="h-2 w-2 shrink-0 rounded-full {tagColorBgClass(item.option.colorToken)}"
										aria-hidden="true"
									></span>
									<span class="min-w-0 flex-1 truncate"
										>{#each highlightMatchSegments(item.option.name, trimmedTyped) as segment, segmentIndex (segmentIndex)}{#if segment.matched}<strong
													class="font-semibold">{segment.text}</strong
												>{:else}{segment.text}{/if}{/each}</span
									>
									{#if isSelected}
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
								</li>
							{:else}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<li
									id="{pickerId}-option-{index}"
									role="option"
									aria-selected="false"
									class="flex h-12 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm text-zinc-700 sm:h-9 {isActive
										? 'bg-zinc-100'
										: ''}"
									onmousedown={(event) => event.preventDefault()}
									onclick={() => createOrSelect(item.rawName)}
									onmouseenter={() => (activeIndex = index)}
								>
									<span class="text-zinc-400" aria-hidden="true">+</span>
									<span class="min-w-0 flex-1 truncate"
										>{m.tags_picker_create({ name: item.rawName })}</span
									>
								</li>
							{/if}
						{/each}
					</ul>
				{/if}
				{#if atMax}
					<p class="px-2 py-1.5 text-[12.5px] text-zinc-500">
						{m.tags_picker_max_reached({ max: MAX_TAGS_PER_TRANSACTION })}
					</p>
				{/if}
			</div>
			<!-- Outside the scrolling wrapper AND outside every <ul role="listbox"> above: a sibling,
			     not an option. It is rendered in all five panel states — loading, empty catalogue,
			     already-selected, the list itself, at-max — because it depends on no data, and the
			     zero-tag state is precisely where a first-time user learns the management surface
			     exists before needing it. Never reached by the arrow keys; Tab reaches it. -->
			<ManageTagsFooter />
		</div>
	{/if}
</div>
