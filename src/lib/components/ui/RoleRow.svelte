<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import type { MappingRole } from '$lib/domain/mappingRoles';
	import { roleLabel, spokenExample } from '$lib/domain/columnMappingLabels';
	import Badge from './Badge.svelte';

	/**
	 * One of the four roles, and the answer it currently holds.
	 *
	 * Lacune C. **A registered variant of `ListCard` (brique 3), not a new pattern**, and the three
	 * differences are the whole of the registration: the right slot carries a chevron rather than a
	 * value, the padding is 14 rather than 16, and the role is TRIGGER rather than data-list element.
	 *
	 * **The sentence a reader who skips this docstring will get wrong.** This is a
	 * `<button aria-haspopup="listbox">` that opens a chooser over the same page. `ListCard` proper
	 * is a focusable container that NAVIGATES to a detail. They look alike and they are not alike,
	 * and merging them is the drift the referential exists to catch. The pattern already exists three
	 * times unregistered (settings rows, category rows, filter-bar triggers), which is why it is
	 * being registered from a fourth rather than written inline a fourth time.
	 *
	 * ## The whole row is the target. The chevron is not a second one.
	 *
	 * The chevron is `aria-hidden` and inside the button. A separate chevron button would double the
	 * tab stops for one action and give assistive technology two names for one thing.
	 *
	 * ## 68 px at 390, 56 px at 1280, and why neither is 48
	 *
	 *     68 = 13 top air + 20 line 1 + 4 gap + 18 line 2 + 13 bottom air
	 *     56 = 20 air     + 18 line 1 + 2 gap + 16 line 2
	 *
	 * The product's control heights are 44 and 48, and these are neither, deliberately: **these are
	 * the heights of a two-line ROW, not of a control.** 48 px does not hold a 20 px line and an 18 px
	 * line with air around them. The figure that has to be respected is the touch-target floor, and
	 * 68 exceeds it by 20. The V2 44 px precedence clause is satisfied with no per-screen exception.
	 *
	 * The recapitulatif is a third height, 64, and it is a different thing: no chevron, **neither a
	 * button nor focusable**, because it opens nothing. A row that looks interactive and is not is
	 * worse than a row that looks inert.
	 *
	 * **§3.7 sizes that row at 44 and this is a recorded deviation, not a drift.** 44 holds one line,
	 * and the one line it held was `column · value`, which asserts a relation between a live fact and
	 * a historical one. The recap branch below says why that pairing is false; the height is the
	 * consequence of stating the two facts separately, and the plate's figure was measured against
	 * copy that no longer exists.
	 *
	 * ## Press and open are visually identical, and that is deliberate
	 *
	 * Both are `background:#f4f4f5`. Pressing leads to opening, so the press is a preview of its own
	 * consequence. The DIFFERENCE is in the timing, and it is the reason this component's transition
	 * is conditional rather than constant: **a press eases in over 120 ms, an open is instantaneous.**
	 * A row never animates into a state it did not reach by touch. `prefers-reduced-motion` is
	 * honoured globally in `layout.css` and needs nothing here.
	 *
	 * At 390 there is no `:hover` at all. Press is not hover, and a sticky hover state on a touch
	 * screen leaves the last-tapped row looking permanently half-open.
	 *
	 * ## The accessible name is composed, and it is already correct when focus returns
	 *
	 * « Montant, colonne designee : Montant, exemple moins 24,90 » and the trailing "bouton" is the
	 * ROLE, contributed by the assistive technology: writing it into the label would announce it
	 * twice. The plate's announcement order requires the name to be up to date BEFORE focus comes
	 * back from the sheet, which is a property of the caller's update order rather than of this
	 * component; what this component owes is that the name is derived from the same props as the
	 * visible text, so the two cannot disagree.
	 *
	 * ## There is no disabled state, and a greyed row is a defect
	 *
	 * No file combination produces one. Even with all three required roles taken, Categorie stays
	 * designable, because a column may legitimately carry two roles. This is recorded because the
	 * absence is the kind of thing a future contributor adds "for completeness".
	 */
	let {
		role,
		state,
		optional = false,
		expanded = false,
		compact = false,
		columnHeader,
		columnIndex,
		sampleValue,
		candidateCount,
		vacatedBy,
		lostHeader,
		onOpen
	}: {
		role: MappingRole;
		state: 'empty' | 'ambiguous' | 'designated' | 'vacated' | 'missingColumn' | 'recap';
		/** Renders the `Optionnel` badge. Required-ness is marked BY EXCEPTION: no asterisks anywhere. */
		optional?: boolean;
		/** The picker for this row is open. Sets `aria-expanded` and the zinc-100 surface. */
		expanded?: boolean;
		/**
		 * Desktop geometry: 56 px instead of 68, chevron pointing down instead of right.
		 *
		 * A prop rather than a `lg:` breakpoint because the two heights are asserted absolutely by
		 * tests, and a breakpoint-driven height cannot be measured without also driving the viewport.
		 */
		compact?: boolean;
		/** The designated column's header as the FILE writes it. Absent when the header is unreadable. */
		columnHeader?: string | null;
		/** Zero based. Used for the `Colonne N` fallback when the header is unreadable. */
		columnIndex?: number;
		/** The first data row's value in the designated column. Truncates; the header does not. */
		sampleValue?: string;
		candidateCount?: number;
		vacatedBy?: MappingRole;
		/** The OLD header, quoted, when a remembered column is gone from the new file. */
		lostHeader?: string;
		onOpen?: () => void;
	} = $props();

	const name = $derived(roleLabel(role));

	/**
	 * A designated column with an unreadable header is named by its position. The raw bytes are NOT
	 * shown here, only in the picker's card: the row is where you check your answer at a glance, and
	 * a line of mojibake in it is noise rather than evidence.
	 */
	const designatedName = $derived(
		columnHeader && columnHeader.trim() !== ''
			? columnHeader
			: m.import_columns_positional_name({ index: (columnIndex ?? 0) + 1 })
	);

	const accessibleName = $derived.by(() => {
		switch (state) {
			case 'ambiguous':
				return m.import_columns_row_aria_candidates({ role: name, count: candidateCount ?? 0 });
			case 'designated':
				return m.import_columns_row_aria_designated({
					role: name,
					header: designatedName,
					value: spokenExample(sampleValue ?? '')
				});
			case 'vacated':
				return m.import_columns_row_aria_vacated({
					role: name,
					vacatedBy: vacatedBy ? roleLabel(vacatedBy) : ''
				});
			case 'missingColumn':
				return m.import_columns_row_aria_missing({ role: name, header: lostHeader ?? '' });
			default:
				return m.import_columns_row_aria_empty({ role: name });
		}
	});

	const heightClass = $derived(compact ? 'h-14' : 'h-[68px]');
	const nameClass = $derived(compact ? 'text-[14px] font-semibold' : 'text-[15px] font-semibold');
	const answerClass = $derived(compact ? 'text-[12.5px]' : 'text-[13px]');
</script>

{#snippet warningTriangle()}
	<svg
		viewBox="0 0 16 16"
		class="h-[13px] w-[13px] shrink-0 text-zinc-600"
		fill="none"
		aria-hidden="true"
	>
		<path
			d="M8 2.5 15 14.5H1L8 2.5Z"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linejoin="round"
		/>
		<path d="M8 6.5v3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
		<circle cx="8" cy="12" r="0.75" fill="currentColor" />
	</svg>
{/snippet}

{#snippet answer()}
	{#if state === 'designated'}
		<span class="flex min-w-0 items-center gap-1.5">
			<!-- shrink-0: the header is the identifier that tells `Date operation` from `Date valeur`. -->
			<span class="shrink-0 {answerClass} font-semibold text-zinc-700">{designatedName}</span>
			<span class="h-[3px] w-[3px] shrink-0 rounded-full bg-zinc-300" aria-hidden="true"></span>
			<!-- min-w-0 + ellipsis: THIS is the half that truncates. -->
			<span
				class="min-w-0 flex-1 overflow-hidden {answerClass} overflow-ellipsis whitespace-nowrap text-zinc-600"
			>
				{sampleValue}
			</span>
		</span>
	{:else if state === 'ambiguous'}
		<span class="flex min-w-0 items-center gap-1.5">
			{@render warningTriangle()}
			<span class="truncate {answerClass} font-semibold text-zinc-700">
				{m.import_columns_row_candidates({ count: candidateCount ?? 0 })}
			</span>
		</span>
	{:else if state === 'vacated'}
		<!-- Never `Choisir une colonne` here: the row would read as having emptied itself. -->
		<span class="truncate {answerClass} font-semibold text-zinc-700">
			{m.import_columns_row_vacated({ role: vacatedBy ? roleLabel(vacatedBy) : '' })}
		</span>
	{:else if state === 'missingColumn'}
		<span class="flex min-w-0 items-center gap-1.5">
			{@render warningTriangle()}
			<span class="truncate {answerClass} font-semibold text-zinc-700">
				{m.import_columns_row_missing({ header: lostHeader ?? '' })}
			</span>
		</span>
	{:else if optional}
		<!-- A consequence, not a warning: no triangle, no tint, zinc-500. -->
		<span class="truncate {answerClass} text-zinc-500">{m.import_columns_row_category_empty()}</span
		>
	{:else}
		<span class="truncate {answerClass} text-zinc-500">{m.import_columns_row_empty()}</span>
	{/if}
{/snippet}

<!--
	THE SKELETON STATE IS GONE, and its removal is a finding rather than a tidy-up (Planche 5f).

	It was built here, on a screen that structurally cannot show it: these rows exist because the file
	is already read in memory, so there is no instant at which the structure is known and the content
	absent. Its `analysing` prop was set by NO ROUTE, which is this repository's own check on any
	state, prop or branch: name the route that produces it, or it is drafted rather than built.

	Brique 9's skeleton now lives where that instant does exist, at `/imports` on arrival from an
	import, which is a server write followed by a list re-read. See `ImportCardSkeleton.svelte`.
-->
{#if state === 'recap'}
	<!--
		Read only. Neither a button nor focusable, because it opens nothing.

		## TWO FACTS, never one pairing, and that is what makes this 64 px rather than the plate's 44

		The plate draws one line, `Date operation · 24/06/2026`, and the middot in it asserts that the
		column named produced the value shown. It does not. The column is read LIVE from the
		correspondance and the value comes from the transactions one import left behind, so the moment
		a correspondance is corrected the two halves belong to different readings and the row states a
		relation that never held. Finding A8, and it lands on the one screen a user opens to work out
		which of two identical import rows to delete.

		The repair is not a caption. A caption sits under the card and the pairing is inside it, so the
		sentence would deny what the row above it still draws. Each fact carries its own label instead,
		on its own line, which costs one line and makes the row 64.

		The labels are per row rather than stated once as column headings, and that is a decision about
		the reading order as much as the geometry. These rows are `div`s with no accessible name of
		their own, so a screen reader reads them linearly: column headings would need real table
		semantics to reach it, and this repository already carries one unregistered table (#332). A
		labelled sentence per line is correct in both channels with no new pattern.

		**The value fact is stated only when there is a value.** A batch whose transactions are gone
		gives every role an empty sample, and « Lu par cet import : » with nothing after it is a label
		doing a fact's job.
	-->
	<div class="flex h-16 flex-col justify-center gap-[3px]">
		<span class="h-[18px] truncate text-[13px] leading-[18px] font-semibold text-zinc-900">
			{name}
		</span>
		{#if columnIndex === undefined}
			<!--
				A role that holds NO column, in a read only recap. `designatedName` falls back to
				`Colonne N` when there is no header, which is right for a designated column with an
				unreadable one and a lie here: it would tell the user their categories were read from
				column 1 of a file that never had a category column. Catégorie says so in its own
				words; a required role with no column says nothing rather than something false.
			-->
			{#if role === 'category'}
				<span class="h-4 truncate text-[12.5px] leading-4 text-zinc-500">
					{m.import_columns_row_category_empty()}
				</span>
			{/if}
		{:else}
			<span class="h-4 truncate text-[12.5px] leading-4 text-zinc-600">
				{m.import_columns_recap_column_fact({ column: designatedName })}
			</span>
			{#if sampleValue}
				<span class="h-4 truncate text-[12.5px] leading-4 text-zinc-600">
					{m.import_columns_recap_value_fact({ value: sampleValue })}
				</span>
			{/if}
		{/if}
	</div>
{:else}
	<button
		type="button"
		aria-haspopup="listbox"
		aria-expanded={expanded}
		aria-label={accessibleName}
		class="flex w-full {heightClass} items-center gap-2.5 text-left focus-visible:ring-4 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white focus-visible:outline-none {expanded
			? 'bg-zinc-100 transition-none'
			: 'bg-transparent transition-colors duration-[120ms] ease-out active:bg-zinc-100'}"
		onclick={onOpen}
	>
		<span class="flex min-w-0 flex-1 flex-col gap-1">
			<span class="flex h-5 items-center gap-1.5">
				<span class="{nameClass} text-zinc-900">{name}</span>
				{#if optional}
					<Badge tone="neutral" shape="rounded">{m.import_columns_optional_badge()}</Badge>
				{/if}
			</span>
			<span class="flex h-[18px] min-w-0 items-center">{@render answer()}</span>
		</span>
		<!-- Decorative. The row is the target; this is not a second one. -->
		{#if compact}
			<svg
				viewBox="0 0 16 16"
				class="h-[15px] w-[15px] shrink-0 text-zinc-400"
				fill="none"
				aria-hidden="true"
			>
				<path
					d="M4 6l4 4 4-4"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
		{:else}
			<svg
				viewBox="0 0 16 16"
				class="h-4 w-4 shrink-0 text-zinc-400"
				fill="none"
				aria-hidden="true"
			>
				<path
					d="M6 4l4 4-4 4"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
		{/if}
	</button>
{/if}

<style>
	/*
	 * Brique 9's 1.6 s pulse. `Skeleton.svelte` carries a byte-identical scoped copy of this rule,
	 * and folding the two into one `layout.css` utility is a separate change rather than a tidy-up
	 * done in passing: `Skeleton.svelte.spec.ts` asserts the SCOPED reduced-motion declaration by
	 * walking `document.styleSheets`, so moving it global turns that spec red for a reason nothing
	 * to do with this component. Filed rather than done silently.
	 *
	 * The reduced-motion guard itself is global (`layout.css`) and covers this without a media query
	 * here, which is why there is not one.
	 */
	.skeleton-pulse {
		animation: role-row-skeleton-pulse 1.6s ease-in-out infinite;
	}

	@keyframes role-row-skeleton-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.55;
		}
	}
</style>
