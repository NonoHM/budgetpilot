<script module lang="ts">
	let idCounter = 0;
</script>

<script lang="ts">
	import type { TagColorToken } from '$lib/domain/tags';
	import { MAX_TAGS_PER_TRANSACTION, normalizeTagName } from '$lib/domain/tags';
	import { normalizeForMatch } from '$lib/domain/normalize';
	import { tagColorBgClass } from '$lib/domain/colors';
	import { inputBase } from '$lib/styles';
	import TagChips from './TagChips.svelte';
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

	const chips = $derived(
		selected.map((tagName) => ({
			key: tagName,
			name: tagName,
			colorToken: options.find((o) => o.name === tagName)?.colorToken ?? null
		}))
	);

	function resetTyped(): void {
		typed = '';
		debounced = '';
		activeIndex = -1;
	}

	function addName(tagName: string): void {
		if (atMax || selected.includes(tagName)) return;
		selected = [...selected, tagName];
	}

	function toggleOption(option: TagPickerOption): void {
		if (selected.includes(option.name)) {
			selected = selected.filter((n) => n !== option.name);
			return;
		}
		if (atMax) return;
		addName(option.name);
		liveAnnouncement = m.tags_picker_added_live({ name: option.name });
		resetTyped();
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
		resetTyped();
	}

	function removeChip(tagName: string): void {
		selected = selected.filter((n) => n !== tagName);
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
			event.preventDefault();
			if (activeIndex === -1 && flatItems.length > 0) activeIndex = 0;
			activate(activeIndex);
		} else if (event.key === 'Escape') {
			open = false;
			activeIndex = -1;
		} else if (event.key === 'Backspace' && typed === '' && selected.length > 0) {
			selected = selected.slice(0, -1);
		}
	}

	const activeId = $derived(activeIndex >= 0 ? `${pickerId}-option-${activeIndex}` : undefined);

	const resultCountLive = $derived.by(() => {
		if (!open) return '';
		if (filtered.length > 0) {
			return filtered.length === 1
				? m.tags_picker_result_count_one({ n: filtered.length })
				: m.tags_picker_result_count_many({ n: filtered.length });
		}
		if (trimmedTyped !== '') return m.tags_picker_no_match_live();
		return '';
	});
</script>

<div class="w-full">
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
			onkeydown={onKeydown}
		/>
	</div>

	{#if name}
		<input type="hidden" {name} value={selected.join('\n')} />
	{/if}

	<div class="sr-only" role="status" aria-live="polite">{resultCountLive}</div>
	<div class="sr-only" role="status" aria-live="polite">{liveAnnouncement}</div>

	{#if open}
		<div
			class="relative z-10 mt-1 max-h-[280px] overflow-y-auto rounded-xl border border-zinc-900 bg-white p-1.5 shadow-lg"
		>
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
			{:else}
				<ul id={listboxId} role="listbox" aria-multiselectable="true">
					{#each flatItems as item, index (item.type === 'option' ? item.option.id : 'create')}
						{@const isActive = index === activeIndex}
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
								class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-700 {isActive
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
								<span class="min-w-0 flex-1 truncate">{item.option.name}</span>
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
								class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-700 {isActive
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
	{/if}
</div>
