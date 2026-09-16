<script lang="ts">
	import * as m from '$lib/paraglide/messages';

	/**
	 * ColumnCard's sibling species: a card that shows the user their own data as EVIDENCE rather
	 * than as an already-interpreted product object. `ColumnCard` transposes one column; this card
	 * offers one of two competing READINGS of the same three raw values. Same geometry, same
	 * reason: `ColumnCard`'s docstring calls the invariance load-bearing twice over (the picker's
	 * measured list length and the skeleton that stands in during analysis are computed from it),
	 * and nothing about that argument is specific to what a card's three lines happen to contain.
	 * Reuse the structure rather than inventing a parallel one: see `ColumnCard.svelte` for the
	 * fuller account of the species (the 107px budget, the truncation rule, the `listbox`/`option`
	 * pattern, `aria-hidden` over a composed label).
	 *
	 * ## 107 px, restated for this card's own three lines
	 *
	 *     1  border-top
	 *    12  padding-top
	 *    20  header line      title + marker, space-between
	 *     6  gap
	 *    17  pair 1           + 2 gap
	 *    17  pair 2           + 2 gap
	 *    17  pair 3
	 *    12  padding-bottom
	 *     1  border-bottom
	 *   ---
	 *   107
	 *
	 * And the plate is explicit that it does not scale: rows elsewhere on this screen shrink with
	 * width because they are tap targets (68 -> 56, 86 -> 74); this card does not, because it is
	 * evidence read off the user's own file, and evidence does not change value at a bigger phone.
	 *
	 * ## Why the raw value stays on every line
	 *
	 * `03/04/2026 → 3 avril 2026` without the left half would let the two cards on screen differ
	 * only in their result, and a user could not tie either back to what their spreadsheet shows.
	 * Raw carries `tabular-nums` because the three rows are read DOWN the column, against the other
	 * card beside it, on the same values; the converted side does not, because tabular figures
	 * inside a sentence read as a table the sentence is not.
	 *
	 * ## The accessible name never repeats the raw side
	 *
	 * The raw side is identical between the two cards: same three file values, read two ways.
	 * Announcing it a second time would spend three spoken values distinguishing nothing. The name
	 * is built from `order` and the three converted `pretty` values alone, and carries no role word
	 * (assistive technology contributes "option" on its own).
	 */
	let {
		order,
		pairs,
		current,
		onSelect
	}: {
		/** Which reading this card offers. Fixes both the visible title and the spoken order name. */
		order: 'day-first' | 'month-first';
		/** The file's own three raw values, read this way. Always three, one per line. */
		pairs: { raw: string; pretty: string }[];
		/** Whether this is the retained reading: the one already assumed or confirmed. */
		current: boolean;
		onSelect?: () => void;
	} = $props();

	const title = $derived(
		order === 'day-first'
			? m.import_datesheet_option_day_first()
			: m.import_datesheet_option_month_first()
	);

	const ariaLabel = $derived(
		m.import_datesheet_option_aria({
			order: title,
			p1: pairs[0]?.pretty ?? '',
			p2: pairs[1]?.pretty ?? '',
			p3: pairs[2]?.pretty ?? ''
		})
	);
</script>

<!--
	Same `role="option"` / `aria-hidden` block split as `ColumnCard`, for the same reason: the
	option's whole announcement is the composed label, so nothing inside may speak twice.

	`tabindex="-1"`, not 0: an option inside an `aria-activedescendant` listbox is never a tab stop
	itself. The listbox (owned by the caller) holds the one tab stop and moves the active
	descendant with the arrow keys.

	No keyboard handler here for the same reason `ColumnCard` has none: it belongs to the listbox,
	and giving this element one too would double-activate on Enter.
-->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	role="option"
	tabindex={-1}
	aria-selected={current}
	aria-label={ariaLabel}
	class="w-full cursor-pointer rounded-[16px] border border-zinc-200 px-[14px] py-3 text-left lg:hover:bg-zinc-50"
	onclick={() => onSelect?.()}
>
	<div aria-hidden="true">
		<div class="flex h-5 items-center justify-between gap-2">
			<span
				class="shrink-0 overflow-hidden text-[13px] font-bold tracking-[0.01em] overflow-ellipsis whitespace-nowrap text-zinc-900"
			>
				{title}
			</span>
			{#if current}
				<span
					class="flex shrink-0 items-center gap-1 overflow-hidden text-[11.5px] font-bold whitespace-nowrap text-zinc-900"
				>
					<!-- Black, not green, matching ColumnCard's designated check: the state of a
					     condition, not the result of an action. -->
					<svg viewBox="0 0 16 16" class="h-[13px] w-[13px] shrink-0" fill="none">
						<path
							d="M3.5 8.5 6.5 11.5 12.5 5"
							stroke="currentColor"
							stroke-width="1.8"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
					{m.import_datesheet_marker_current()}
				</span>
			{/if}
		</div>

		<div data-testid="date-reading-card-lines" class="mt-1.5 grid gap-0.5">
			{#each pairs as pair, position (position)}
				<!--
					One line box per pair, fixed at 17px like ColumnCard's value lines, so a converted
					value too long to fit TRUNCATES rather than wrapping and growing the card. A single
					block-level span with `overflow-ellipsis` still ellipses correctly with mixed-colour
					inline children inside it; only the raw child carries `tabular-nums`, never the
					whole line, because the converted side is prose and must not look like a table.
				-->
				<span
					class="block h-[17px] overflow-hidden text-[13.5px] leading-[17px] overflow-ellipsis whitespace-nowrap"
				>
					<span class="text-zinc-500 tabular-nums">{pair.raw}</span>
					<span class="text-zinc-400">→</span>
					<span class="text-zinc-900">{pair.pretty}</span>
				</span>
			{/each}
		</div>
	</div>
</div>
