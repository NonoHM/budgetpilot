<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import type { MappingRole } from '$lib/domain/mappingRoles';
	import { roleLabel, spokenExample } from '$lib/domain/columnMappingLabels';

	/**
	 * One column of the user's file, TRANSPOSED: header on top, its first three real values below.
	 *
	 * Lacune A of the design plate, and the reason it is a lacuna is worth keeping: the referential
	 * presents an already-interpreted product object in every one of its sixteen briques. It shows
	 * the user's RAW DATA nowhere. This is the first piece that does, and it will recur (OFX and QIF
	 * import, choosing a sheet in an .xlsx, any third-party file preview), which is why it is
	 * registered as its own component rather than written inside the picker that needed it.
	 *
	 * **It is not a bigger Dropdown item.** Brique 10 defines an item as one 13.5 px line of text
	 * with a check; this is 107 px carrying an identifier and three data values, which is a different
	 * species. Take from brique 10 the `listbox` ARIA pattern, the keyboard, the selection check, the
	 * zinc-100 selected background and the open durations. Do NOT add a `size="rich"` prop to brique
	 * 10: this mounts INSIDE a brique-10 listbox and stays its own piece.
	 *
	 * ## 107 px, and it does not move
	 *
	 *     1  border-top
	 *    12  padding-top
	 *    20  header line      identifier + marker, space-between
	 *     6  gap
	 *    17  value 1          + 2 gap
	 *    17  value 2          + 2 gap
	 *    17  value 3
	 *    12  padding-bottom
	 *     1  border-bottom
	 *   ---
	 *   107
	 *
	 * The invariance is load-bearing twice over: the picker's measured list length (1857 px at 15
	 * columns, 3.1 body heights) is computed from it, and the skeleton that stands in during analysis
	 * is exact only because the final render cannot be a different height. Every line is therefore a
	 * FIXED line box with `nowrap` and an ellipsis, never a wrapping paragraph.
	 *
	 * The figures quoted as `15 px` and `13.5 px` and `11.5 px` in the plate are TYPE SIZES, not line
	 * boxes: the plate lists heights in a separate block and 15 is not in it. So the unreadable
	 * header's raw text is 15 px type inside the same 17 px line box as the value it replaces, which
	 * is what lets the plate say "the card stays 107" in the same sentence.
	 *
	 * ## The truncation rule: a VALUE truncates, an IDENTIFIER never does
	 *
	 * The header is the only thing that lets a user tell `Date operation` from `Date valeur`, so it
	 * is `flex-shrink: 0` and it is the marker beside it that gives way. The values are what
	 * truncate, because a value is evidence and a prefix of it is still evidence.
	 *
	 * ## `(vide)` rather than a blank line
	 *
	 * An empty cell renders the word, in zinc-400. Three blank lines read as a broken card, when what
	 * is actually being said is that the column is empty, and "this column is empty" is exactly the
	 * information someone choosing a column needs. A blank space says nothing and looks like a bug.
	 *
	 * ## No monospace, and where digit alignment actually comes from
	 *
	 * The referential is a one-family design (system stack). A second family for three lines of a
	 * card would be the largest typographic decision on the screen taken for the smallest reason.
	 * Column alignment is instead carried by `font-variant-numeric: tabular-nums`, applied only when
	 * all three examples parse as numbers or dates, which is what `numeric` means.
	 *
	 * `numeric` is a PROP because the plate's component signature makes it one. The hazard that
	 * creates: "parses as a number or a date" is a predicate, and a predicate passed as a boolean is
	 * one every call site re-derives. When PR7 wires the picker, that predicate gets ONE
	 * implementation that both the card and its tests call, never a regex written twice.
	 *
	 * ## OWNER RULING 1, and the plate clause it refuses
	 *
	 * This is one of the three homes the ruling requires, and it is here rather than only in the plan
	 * because it sits beside the marker that implements it. The plate is a PDF and cannot be edited,
	 * so a refusal recorded only in a plan is a refusal a future session will reopen.
	 *
	 * **Refused, for this screen: the plate's clause « la contrainte d'unicite est celle du role, pas
	 * celle de la colonne », and its 1g table row « La meme colonne pour Libelle et Categorie ».**
	 * Deleted rather than amended. Categorie may not take a column a required role holds. The
	 * displacement the plate designs (1g) stays between the three REQUIRED roles and is unchanged.
	 *
	 * The reasoning, so it is not reopened on the strength of the cost line. The plate weighed this
	 * as a one-off mis-designation, which it would be under a screen that asks every time. Under
	 * layer three the answer is MEMORISED, so the outcome repeats unattended on every later import:
	 * a 148-line file with 100 distinct merchants creates **100 categories**, hand-repairable only.
	 * A sentence read once, against a hundred categories created every time, is not an even trade.
	 *
	 * And the clause's own defence does not survive contact with it: the defensible case was said to
	 * be a file with a single text column, but a single text column is a LABEL, not a category, so
	 * designating it as both categorises nothing. The Repartition plate's version of the clause is
	 * untouched, because there the repeated thing is a category across the parts of one transaction,
	 * which is legitimate.
	 *
	 * The other two homes are the `ColumnMapping` model docstring and
	 * `validateColumnMapping`'s `category-repeats-required-role` branch, which is where the refusal
	 * is actually ENFORCED. This component only renders it: a card that is merely unchoosable is an
	 * affordance, and the control is on the server.
	 *
	 * ## `unavailable` is `aria-disabled`, never `disabled`
	 *
	 * A column already held by a required role is still shown in the Categorie picker, because
	 * removing it would send the user hunting for a column that is visibly in their
	 * file. It is marked and it is not selectable, and it stays reachable at the keyboard so its
	 * reason stays readable. `disabled` would take it out of the accessibility tree and out of the
	 * tab order at once, which is the same as hiding it with extra steps.
	 *
	 * ## One composed `aria-label`, on the option, over an `aria-hidden` visual block
	 *
	 * « Date operation. Trois exemples : 24/06/2026, 22/06/2026, 21/06/2026. Actuellement designee
	 * comme Date. » Three values announced in one string are useful; three separate nodes to walk
	 * through, each announcing its own nothing, are not. So the block is `aria-hidden` and the option
	 * carries the whole sentence.
	 */
	let {
		header,
		index,
		values,
		forRole,
		marker = 'none',
		heldByRole,
		headerUnreadable = false,
		numeric = false,
		selected = false,
		unavailable = false,
		id,
		onSelect
	}: {
		/** The header cell as the file writes it, or `null` when the file has no header row. */
		header: string | null;
		/** Zero based position in the file. Only ever displayed as `index + 1`. */
		index: number;
		/** The first three values of this column, in file order. Empty strings render as `(vide)`. */
		values: readonly string[];
		/**
		 * The role whose picker this card is sitting in.
		 *
		 * An addition to the plate's signature, and it is not a convenience: the plate specifies the
		 * composed label verbatim as « ... Actuellement designee comme Date. », and `marker:
		 * 'designated'` means "designated for THIS role" without saying which role that is. Without
		 * this prop the sentence cannot be written, and a card would have to guess or omit the half
		 * that carries the meaning.
		 */
		forRole: MappingRole;
		marker?: 'none' | 'proposed' | 'designated' | 'heldBy';
		/** Required when `marker` is `heldBy`: naming the other role is the whole point of the marker. */
		heldByRole?: MappingRole;
		/** The header exists but is empty or undecodable. The raw bytes are still shown, never repaired. */
		headerUnreadable?: boolean;
		/** All three examples parse as numbers or dates. See the docstring: this is a predicate, not a style. */
		numeric?: boolean;
		selected?: boolean;
		/** Held by a required role while the Categorie picker is open. Owner ruling 1. */
		unavailable?: boolean;
		/**
		 * DOM id so the enclosing listbox can point `aria-activedescendant` at this option. Options in
		 * a listbox are not individually tabbable, so there is no `tabindex` prop and there must not
		 * be one: a roving tabindex and an active descendant are two different patterns and mixing
		 * them announces the wrong node.
		 */
		id?: string;
		onSelect?: () => void;
	} = $props();

	/**
	 * The title falls back to the position for FOUR distinct causes, and they are deliberately not
	 * distinguished here: no header row at all, an empty header cell, an undecodable one, and a
	 * header that decoded to nothing but whitespace. What the user needs is a stable way to refer to
	 * the column; which of the four produced it is answered by the marker line and by the raw text.
	 */
	const title = $derived(
		header && header.trim() !== '' && !headerUnreadable
			? header
			: m.import_columns_positional_name({ index: index + 1 })
	);

	const showsRawHeader = $derived(headerUnreadable && (header ?? '') !== '');

	/**
	 * Exactly three lines, always. The raw unreadable header REPLACES the third value rather than
	 * being added below it, which is what holds the card at 107.
	 */
	const lines = $derived([
		values[0] ?? '',
		values[1] ?? '',
		showsRawHeader ? null : (values[2] ?? '')
	]);

	const markerText = $derived.by(() => {
		if (marker === 'designated') return m.import_columns_card_designated();
		if (marker === 'heldBy' && heldByRole)
			return m.import_columns_card_held_by({ role: roleLabel(heldByRole) });
		// `proposed` carries no badge: its group heading already says so, and a badge repeating the
		// heading is the second reason location this design forbids.
		if (headerUnreadable) return m.import_columns_card_unreadable_header();
		return null;
	});

	const spokenValues = $derived(
		[values[0] ?? '', values[1] ?? '', values[2] ?? ''].map(spokenExample).join(', ')
	);

	const ariaLabel = $derived.by(() => {
		const parts = [m.import_columns_card_aria_examples({ header: title, values: spokenValues })];
		if (headerUnreadable) parts.push(m.import_columns_card_aria_unreadable());
		if (marker === 'designated')
			parts.push(m.import_columns_card_aria_designated_as({ role: roleLabel(forRole) }));
		if (marker === 'heldBy' && heldByRole)
			parts.push(m.import_columns_card_held_by({ role: roleLabel(heldByRole) }));
		return parts.join(' ');
	});

	function activate() {
		// A soft-disabled control swallows its own activation rather than relying on being
		// unclickable: a programmatic `element.click()`, an assistive technology and a synthetic
		// event all reach this handler, and `aria-disabled` stops none of them.
		if (unavailable) return;
		onSelect?.();
	}
</script>

<!--
	`role="option"` on the outer element and the visual block `aria-hidden` below it: the option's
	whole announcement is the composed label, so nothing inside must be able to speak twice.

	`tabindex="-1"` and NOT 0. An option in an `aria-activedescendant` listbox is never a tab stop:
	the listbox holds the one tab stop and moves the active descendant with the arrow keys. Fifteen
	columns must not be fifteen tab stops.

	The keyboard handler belongs to the listbox for the same reason, so this element deliberately has
	none. Adding one here would mean Enter both moved the active descendant AND fired the option,
	which is a double activation nobody can see in review. The warning is suppressed rather than
	satisfied, because satisfying it is the defect.
-->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	{id}
	role="option"
	tabindex={-1}
	aria-selected={selected}
	aria-disabled={unavailable ? 'true' : undefined}
	aria-label={ariaLabel}
	class="w-full rounded-[16px] border border-zinc-200 px-[14px] py-3 text-left {selected ||
	marker === 'designated'
		? 'bg-zinc-100'
		: 'bg-white'} {unavailable ? 'opacity-60' : 'cursor-pointer'}"
	onclick={activate}
>
	<div aria-hidden="true">
		<div class="flex h-5 items-center justify-between gap-2">
			<!-- flex-shrink-0: the identifier is what tells `Date operation` from `Date valeur`. -->
			<span
				class="shrink-0 overflow-hidden text-[13px] font-bold tracking-[0.01em] overflow-ellipsis whitespace-nowrap text-zinc-900"
			>
				{title}
			</span>
			{#if markerText}
				<span
					class="flex shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap {marker ===
					'designated'
						? 'text-[11.5px] font-bold text-zinc-900'
						: 'text-[11.5px] font-semibold text-zinc-700'}"
				>
					{#if marker === 'designated'}
						<!-- Black, not green. This is the state of a condition, not the result of an action. -->
						<svg viewBox="0 0 16 16" class="h-[13px] w-[13px] shrink-0" fill="none">
							<path
								d="M3.5 8.5 6.5 11.5 12.5 5"
								stroke="currentColor"
								stroke-width="1.8"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					{/if}
					{markerText}
				</span>
			{/if}
		</div>

		<div
			data-testid="column-card-values"
			class="mt-1.5 grid gap-0.5 {numeric ? 'tabular-nums' : ''}"
		>
			{#each lines as line, position (position)}
				{#if line === null}
					<!--
						The raw bytes of an unreadable header, kept VERBATIM and never silently repaired:
						a repair that guesses wrong is indistinguishable from a file that really says that.
						15 px type inside the same 17 px line box as the value it replaces, which is why
						the card is still 107.
					-->
					<span
						class="block h-[17px] overflow-hidden text-[15px] leading-[17px] overflow-ellipsis whitespace-nowrap text-zinc-400"
					>
						{header}
					</span>
				{:else if line.trim() === ''}
					<span class="block h-[17px] text-[13.5px] leading-[17px] text-zinc-400">
						{m.import_columns_card_empty_value()}
					</span>
				{:else}
					<span
						class="block h-[17px] overflow-hidden text-[13.5px] leading-[17px] overflow-ellipsis whitespace-nowrap text-zinc-600"
					>
						{line}
					</span>
				{/if}
			{/each}
		</div>
	</div>
</div>
