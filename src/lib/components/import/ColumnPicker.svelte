<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import type { MappingRole } from '$lib/domain/mappingRoles';
	import {
		isUnavailableFor,
		roleHolding,
		type DesignationFile,
		type RoleAssignment
	} from '$lib/domain/columnDesignation';
	import BottomSheet from '$lib/components/BottomSheet.svelte';
	import ColumnCard from '$lib/components/ui/ColumnCard.svelte';
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';

	/**
	 * The column chooser: a brique-15 bottom sheet holding a brique-10 listbox of `ColumnCard`s.
	 *
	 * ## Three groups, in this order, and a column appears in exactly ONE
	 *
	 *   1. `Désignée`, 0 or 1 card: the column this role already holds.
	 *   2. `Proposée · n`, omitted ENTIRELY, heading included, when there is none.
	 *   3. `Toutes les colonnes · n`, in the FILE's own order.
	 *
	 * A designated or proposed column is not repeated in the bottom group. The rule is what makes
	 * the common case one tap: the answer is pinned at the top, and the list below is a fallback
	 * rather than a second place to look for the same card.
	 *
	 * The empty-proposal case renders no heading and no « Aucune proposition ». A heading over
	 * nothing is a promise the sheet cannot keep, and an explicit empty state here would be the
	 * brique-7 EmptyState, which is a page-level component with a round icon and belongs to a
	 * screen rather than to a listbox.
	 *
	 * ## Choosing applies and closes. There is no « Valider »
	 *
	 * Like a Dropdown item. The sheet has no footer at all, which is how it satisfies the
	 * sheet-footer rule (the primary action never scrolls) rather than by pinning something.
	 *
	 * ## Focus, and the one deviation from the plate
	 *
	 * The plate says focus goes to the sheet TITLE on open, so the question is heard before the
	 * options. `BottomSheet` offers `'first-focusable'` and `'panel'`, not "the title", and
	 * `'first-focusable'` would land on the close button. `'panel'` focuses the dialog, whose
	 * `aria-label` IS the question, so the question is announced first and the options are reached
	 * by moving forward. Same audible outcome, through the existing API rather than a new prop.
	 *
	 * ## Above 20 columns
	 *
	 * A pinned search field appears outside the scrolling area. It is the only place in the whole
	 * flow where a keyboard opens, which is why it is gated on a count rather than always present:
	 * below the threshold you do not know the name you are looking for, and the field would open a
	 * keyboard for nothing.
	 */
	let {
		open = false,
		role,
		file,
		assignment,
		candidates = [],
		searchThreshold = 20,
		onChoose,
		onClose,
		onToggleHeaderRow
	}: {
		open?: boolean;
		role: MappingRole;
		file: DesignationFile;
		assignment: RoleAssignment;
		/** Column indices detection proposes for this role. Never includes the designated one. */
		candidates?: readonly number[];
		/**
		 * Column count above which the search field appears. A prop only so a test can reach the
		 * threshold without building a 21-column fixture for every case; the default is the plate's.
		 */
		searchThreshold?: number;
		onChoose?: (columnIndex: number) => void;
		onClose?: () => void;
		onToggleHeaderRow?: () => void;
	} = $props();

	let query = $state('');

	const TITLES: Record<MappingRole, () => string> = {
		date: m.import_columns_picker_title_date,
		label: m.import_columns_picker_title_label,
		amount: m.import_columns_picker_title_amount,
		category: m.import_columns_picker_title_category
	};

	const title = $derived(TITLES[role]());
	const columnCount = $derived(file.headers.length);
	const searchable = $derived(columnCount > searchThreshold);

	const designatedIndex = $derived(assignment[role]);

	/** Proposals, minus anything already in the `Désignée` group, so no card appears twice. */
	const proposed = $derived(candidates.filter((index) => index !== designatedIndex));

	const matches = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		const all = file.headers.map((_, index) => index);
		if (!searchable || needle === '') return all;
		return all.filter((index) => (file.headers[index] ?? '').toLowerCase().includes(needle));
	});

	/** The bottom group: everything not already shown above it, in FILE order. */
	const rest = $derived(
		matches.filter((index) => index !== designatedIndex && !proposed.includes(index))
	);

	function titleFor(index: number): string | null {
		return file.hasHeaderRow ? (file.headers[index] ?? null) : null;
	}

	function markerFor(index: number): 'none' | 'proposed' | 'designated' | 'heldBy' {
		if (index === designatedIndex) return 'designated';
		const holder = roleHolding(assignment, index);
		if (holder !== null && holder !== role) return 'heldBy';
		if (proposed.includes(index)) return 'proposed';
		return 'none';
	}

	function cardFor(index: number) {
		return {
			header: titleFor(index),
			index,
			values: file.samples[index] ?? [],
			forRole: role,
			marker: markerFor(index),
			heldByRole: roleHolding(assignment, index) ?? undefined,
			headerUnreadable: file.hasHeaderRow && (file.headers[index] ?? '').trim() === '',
			selected: index === designatedIndex,
			unavailable: isUnavailableFor(assignment, role, index),
			id: `column-option-${index}`,
			onSelect: () => onChoose?.(index)
		};
	}
</script>

<BottomSheet {open} ariaLabel={title} onClose={() => onClose?.()} initialFocus="panel">
	{#snippet header()}
		<div class="flex items-start justify-between gap-2 px-4 pb-3.5">
			<div class="min-w-0">
				<h2 class="text-[17px] leading-[22px] font-bold text-zinc-900">{title}</h2>
				<p class="text-[12.5px] leading-[18px] text-zinc-500">
					{m.import_columns_picker_subtitle({ columns: columnCount })}
				</p>
			</div>
			<IconButton label={m.import_columns_picker_close()} onclick={() => onClose?.()}>
				<svg viewBox="0 0 20 20" class="h-5 w-5" fill="none" aria-hidden="true">
					<path
						d="M5 5l10 10M15 5L5 15"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
					/>
				</svg>
			</IconButton>
		</div>
	{/snippet}

	{#if searchable}
		<!--
			Pinned OUTSIDE the scrolling list, and the only keyboard in the whole flow. The result
			count is announced politely, following TagPicker's convention rather than inventing a
			second one.
		-->
		<div class="border-b border-zinc-200 px-5 pb-3">
			<input
				type="search"
				bind:value={query}
				placeholder={m.import_columns_search_placeholder()}
				aria-label={m.import_columns_search_placeholder()}
				class="h-12 w-full rounded-[14px] border border-zinc-200 px-3.5 text-[15px]"
				data-testid="column-search"
			/>
			<p class="sr-only" role="status" aria-live="polite">
				{m.import_columns_search_result_count({ count: matches.length })}
			</p>
		</div>
	{/if}

	<div
		role="listbox"
		aria-label={title}
		class="flex flex-col gap-2 px-5 pt-3.5"
		data-testid="column-listbox"
	>
		<!--
			Above the cards, because it redefines the TITLE of every card below it. Accepted cost:
			48 px in every picker. Placing it under the list would make the user scroll past fifteen
			cards whose titles are wrong to find the control that fixes them.
		-->
		<TapLink onclick={() => onToggleHeaderRow?.()}>
			{file.hasHeaderRow
				? m.import_columns_picker_first_row_is_data()
				: m.import_columns_picker_first_row_is_header()}
		</TapLink>

		{#if designatedIndex !== null}
			<p class="pt-1 text-[11px] font-bold tracking-[0.03em] text-zinc-500 uppercase">
				{m.import_columns_group_designated()}
			</p>
			<ColumnCard {...cardFor(designatedIndex)} />
		{/if}

		{#if proposed.length > 0}
			<p class="pt-1 text-[11px] font-bold tracking-[0.03em] text-zinc-500 uppercase">
				{proposed.length === 1
					? m.import_columns_group_proposed_one()
					: m.import_columns_group_proposed_many({ count: proposed.length })}
			</p>
			{#each proposed as index (index)}
				<ColumnCard {...cardFor(index)} />
			{/each}
		{/if}

		{#if rest.length > 0}
			<p class="pt-1 text-[11px] font-bold tracking-[0.03em] text-zinc-500 uppercase">
				{m.import_columns_group_all({ count: rest.length })}
			</p>
			{#each rest as index (index)}
				<ColumnCard {...cardFor(index)} />
			{/each}
		{:else if searchable && query.trim() !== ''}
			<!--
				A 48 px line INSIDE the listbox, not the brique-7 EmptyState: that is a page-level
				component with a round icon, and this is a message inside a list.
			-->
			<div class="flex h-12 items-center justify-between gap-3" data-testid="search-empty">
				<span class="text-[13px] text-zinc-500">{m.import_columns_search_no_result()}</span>
				<TapLink onclick={() => (query = '')}>{m.import_columns_search_clear()}</TapLink>
			</div>
		{/if}

		<!-- The white fade and home indicator area under the last card. -->
		<div class="h-14 shrink-0" aria-hidden="true"></div>
	</div>
</BottomSheet>
