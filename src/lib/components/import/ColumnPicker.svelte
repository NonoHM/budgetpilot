<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import type { MappingRole } from '$lib/domain/mappingRoles';
	import {
		isSamplePadding,
		isUnavailableFor,
		roleHolding,
		type ResolvedDesignationFile,
		type RoleAssignment
	} from '$lib/domain/columnDesignation';
	import BottomSheet from '$lib/components/BottomSheet.svelte';
	import ColumnCard from '$lib/components/ui/ColumnCard.svelte';
	import DateReadingCard from '$lib/components/ui/DateReadingCard.svelte';
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import SwitchRow from '$lib/components/ui/SwitchRow.svelte';

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
	 *
	 * ## `step`: ONE SURFACE, TWO BODIES, plate 7b
	 *
	 * The date role's column question can defer a second question, the date order, into the SAME
	 * sheet rather than a nested one: choosing an ambiguous column applies immediately (§5.3 holds)
	 * and the CLOSE alone is deferred by exactly one question. `step` swaps the title, the subline
	 * and the body; nothing else about the surface changes, including its height class.
	 *
	 * **The step change carries no transition, deliberately: 0 ms, not a slide.** A slide implies a
	 * navigation depth the back gesture then has to contradict (7d: back closes the sheet, it never
	 * steps back to step 1), and the sheet's edges must not move under a finger already resting on
	 * the glass. Consequence worth having: there is one motion path, so `prefers-reduced-motion`
	 * changes nothing here — the chosen behaviour already IS the no-motion behaviour. A plain
	 * `{#if}` swap is therefore correct as written; adding a `transition:` to either body would be
	 * the regression this paragraph exists to name.
	 *
	 * **Both steps are the SAME `listbox`, never two roles.** Step 2 is not a radiogroup: a
	 * radiogroup's own guidance prefers a selection saved on an explicit submit, and step 2 applies
	 * and closes on choose exactly as step 1 does, which is a second control this sheet's whole
	 * argument (closing is free) refuses. A user who learned step 1's keyboard does not relearn
	 * step 2's.
	 *
	 * **`step: 'reading'` needs `dateReading` and a designated column to mean anything.** Passed
	 * without either, the sheet renders step 1 regardless: an ambiguous request is not a rendered
	 * empty question. This is `effectiveStep`, and it is what every other derivation in this file
	 * reads instead of the raw prop.
	 *
	 * ## `committed`, and the rule it exists for
	 *
	 * A flag this component owns, true once the OPEN-TO-CLOSE SESSION — both steps — has applied
	 * anything: designating a column, or choosing a reading. It resets to `false` on every fresh
	 * open, per 7d's rule that a session run twice must not remember the first run's answer.
	 *
	 * **The rule it exists for, stated so the caller does not have to re-derive it:** a close
	 * announces if and only if the session committed something. Re-choosing the column already
	 * designated is the one exception on the columns side (§5.3: a no-op, nothing applied); every
	 * reading choice on the readings side commits, including re-confirming the one already retained
	 * (7j: assumed → confirmed is a value change).
	 *
	 * `committed` is not exposed as its own prop. It is threaded through as the one argument to
	 * `onClose`, because every close this component can originate — the header's own close control,
	 * `BottomSheet`'s Escape/backdrop/swipe — already funnels through that single callback, and a
	 * second prop carrying the same fact would be a value the caller could read stale.
	 *
	 * ## What `step` does NOT attempt
	 *
	 * The system back gesture is ruled to close the sheet and never step back to step 1 (7d), but
	 * nothing in this application pushes a history entry for a sheet opening, so there is no back
	 * gesture for this component to intercept yet. Documented rather than silently unhandled: the
	 * day a sheet-level history entry exists, it must resolve to the same `onClose(committed)` path
	 * every other close already uses, not a seventh one.
	 *
	 * Height parity between the two bodies (the plate's 717 px at both steps, ~300 px of air under
	 * the two cards) is NOT implemented. The sheet's height stays content-driven, exactly as it
	 * already is across different files at step 1 today; matching it would need a measurement of
	 * step 1's own rendered height carried across the swap, which is a real feature and was left out
	 * rather than built half-heartedly. A step 1 → step 2 switch on a short file can therefore move
	 * the sheet's top edge, which is exactly what 7b's "roughly 300 px of air" is paid to prevent.
	 */
	let {
		open = false,
		variant = 'sheet',
		role,
		file,
		assignment,
		candidates = [],
		searchThreshold = 20,
		step = 'columns',
		dateReading,
		onChoose,
		onChooseReading,
		onChangeColumn,
		onClose,
		onToggleHeaderRow
	}: {
		open?: boolean;
		/**
		 * Which shell the SAME listbox is presented in.
		 *
		 * `sheet` at 390 and `anchored` at 1280, following `PeriodFilter` and `TagPicker`, which
		 * already ship this exact split: `BottomSheet` below the breakpoint, an `absolute top-full`
		 * popover above it, one trigger, one chevron.
		 *
		 * The body is identical in both, rendered from one snippet, so the group order, the
		 * markers, the search threshold and the ARIA pattern cannot differ by width. Only the box
		 * around it changes.
		 */
		variant?: 'sheet' | 'anchored';
		role: MappingRole;
		file: ResolvedDesignationFile;
		assignment: RoleAssignment;
		/** Column indices detection proposes for this role. Never includes the designated one. */
		candidates?: readonly number[];
		/**
		 * Column count above which the search field appears. A prop only so a test can reach the
		 * threshold without building a 21-column fixture for every case; the default is the plate's.
		 */
		searchThreshold?: number;
		/**
		 * Which body the ONE surface currently shows. See the class docstring's `step` section.
		 * Controlled: this component never advances it on its own, including on choosing a reading —
		 * closing after that choice is the caller's decision via `onChoose`/`onChooseReading` having
		 * fired, same as step 1 never closes itself on `onChoose`.
		 */
		step?: 'columns' | 'reading';
		/**
		 * The designated column's date evidence, read both ways. Absent (or paired with no designated
		 * column) makes `step: 'reading'` render step 1 instead — see `effectiveStep`.
		 */
		dateReading?: {
			/** Parallel to `file.samples[designatedIndex]`, position for position. */
			dayFirstPretty: readonly string[];
			monthFirstPretty: readonly string[];
			/** The reading already assumed (app locale) or confirmed (a prior choice this session). */
			retained: 'day-first' | 'month-first';
		};
		onChoose?: (columnIndex: number) => void;
		/** Fired when a reading is chosen, by click or by the keyboard (arrow move IS the choice). */
		onChooseReading?: (order: 'day-first' | 'month-first') => void;
		/** The step 2 foot TapLink: a re-ask for step 1, never a close. See the class docstring. */
		onChangeColumn?: () => void;
		/**
		 * Fired for every close this component originates that is not already an `onChoose`: the
		 * header's close control, and `BottomSheet`'s own Escape/backdrop/swipe.
		 *
		 * @param committed Whether the open-to-close session applied anything. See the class
		 *   docstring's `committed` section for the exact rule; this parameter IS that flag.
		 */
		onClose?: (committed: boolean) => void;
		onToggleHeaderRow?: () => void;
	} = $props();

	let query = $state('');
	let panelEl = $state<HTMLElement | null>(null);
	let panelMaxHeight = $state<number | null>(null);

	/**
	 * Measured FROM THE PANEL'S OWN TOP, never as a viewport fraction.
	 *
	 * A size in viewport units is not a constraint on an element that starts partway down the page:
	 * this repository has measured `max-h-[70vh]` on a panel anchored 290 px into a 900 px viewport
	 * putting its primary action at y=960. The panel begins under a row that is itself partway down
	 * a command column, so the only figure that bounds it is the room actually left below it.
	 *
	 * The 240 floor keeps it usable rather than collapsing to a sliver when the row sits low; below
	 * that, scrolling inside the panel is the better failure. Same shape as `PeriodFilter`'s.
	 */
	$effect(() => {
		if (!open || variant !== 'anchored') {
			panelMaxHeight = null;
			return;
		}
		const box = panelEl?.getBoundingClientRect();
		if (!box) return;
		panelMaxHeight = Math.max(240, Math.round(window.innerHeight - box.top - 16));
	});

	const TITLES: Record<MappingRole, () => string> = {
		date: m.import_columns_picker_title_date,
		label: m.import_columns_picker_title_label,
		amount: m.import_columns_picker_title_amount,
		category: m.import_columns_picker_title_category
	};

	const designatedIndex = $derived(assignment[role]);

	/**
	 * `step` narrowed to what is actually renderable. `dateReading` is what the caller must supply
	 * for the question to exist at all, and a designated column is what the question is ABOUT — a
	 * `step: 'reading'` missing either falls back to columns rather than rendering an empty sheet,
	 * per the class docstring.
	 */
	const effectiveStep = $derived(
		step === 'reading' && dateReading && designatedIndex !== null ? 'reading' : 'columns'
	);

	/** One title (and `aria-label`) for the whole surface, step-aware. See the `step` docstring. */
	const title = $derived(effectiveStep === 'reading' ? m.import_datesheet_title() : TITLES[role]());
	const columnCount = $derived(file.headers.length);
	const searchable = $derived(columnCount > searchThreshold);

	/** Proposals, minus anything already in the `Désignée` group, so no card appears twice. */
	const proposed = $derived(candidates.filter((index) => index !== designatedIndex));

	/**
	 * The proposed group's heading, computed once because it is now written twice: as the group's
	 * accessible NAME and as the paragraph a sighted user reads. Two call sites of one sentence is
	 * exactly where a plural rule drifts, so there is one expression of it.
	 */
	const proposedGroupLabel = $derived(
		proposed.length === 1
			? m.import_columns_group_proposed_one()
			: m.import_columns_group_proposed_many({ count: proposed.length })
	);

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

	/**
	 * True when the designated column's header cannot be read: no header row at all, or an empty
	 * cell under one. Same predicate `cardFor` already computes for `headerUnreadable`, restated
	 * here rather than imported from it because `cardFor` is keyed by an arbitrary column index and
	 * this one is always about `designatedIndex`.
	 */
	const dateReadingHeaderUnreadable = $derived(
		designatedIndex !== null &&
			file.hasHeaderRow &&
			(file.headers[designatedIndex] ?? '').trim() === ''
	);

	/** Step 2's subline: the column's own header, or its position when there is none to read. */
	const dateReadingSubline = $derived.by(() => {
		if (designatedIndex === null) return '';
		const header = titleFor(designatedIndex);
		const readable = header !== null && header.trim() !== '' && !dateReadingHeaderUnreadable;
		return readable
			? m.import_datesheet_subline({ header })
			: m.import_datesheet_subline_no_header({ count: designatedIndex + 1 });
	});

	/** The one subline paragraph under the title, step-aware, so it is composed in exactly one place. */
	const subline = $derived(
		effectiveStep === 'reading'
			? dateReadingSubline
			: m.import_columns_picker_subtitle({ columns: columnCount })
	);

	/**
	 * The designated column's raw samples, read both ways, PAIRED with `DateReadingCard`'s own
	 * `{ raw, pretty }` shape. `file.samples` is the one copy of the raw values in this component;
	 * `dateReading` carries only the two prettified arrays, never a second copy of the raw side.
	 *
	 * **Paired FIRST, filtered SECOND, and the order is the whole fix (#669).** `samples` is padded
	 * to three with `SAMPLE_PADDING`, which is `ColumnCard`'s « (vide) » and a value this file does
	 * not contain. Dropped from the raw array alone, the survivors would shift against the pretty
	 * array and print one cell beside its neighbour's conversion; dropped as a PAIR, position is
	 * kept by construction. A two-row file therefore offers two readings, not two and a bare arrow.
	 */
	const readingRawSamples = $derived(
		designatedIndex !== null ? (file.samples[designatedIndex] ?? []) : []
	);
	function pairsFor(pretty: readonly string[] | undefined) {
		return readingRawSamples
			.map((raw, index) => ({ raw, pretty: pretty?.[index] ?? '' }))
			.filter((pair) => !isSamplePadding(pair.raw));
	}
	const dayFirstPairs = $derived(pairsFor(dateReading?.dayFirstPretty));
	const monthFirstPairs = $derived(pairsFor(dateReading?.monthFirstPretty));

	/**
	 * `committed`: true once THIS open-to-close session has applied anything, across both steps.
	 * See the class docstring's `committed` section for the rule it exists to answer.
	 *
	 * Reset on the false→true edge of `open` alone, tracked through a plain (non-reactive) variable
	 * rather than a second `$state`: a session's start is a TRANSITION, not a level, and reading
	 * `open` inside the effect below is what keeps this effect's only dependency the prop that
	 * actually defines a session's boundary.
	 */
	let committed = $state(false);
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) committed = false;
		wasOpen = open;
	});

	/** Choosing a column. Re-choosing the one already designated is §5.3's no-op: it does not commit. */
	function chooseColumn(index: number) {
		if (index !== designatedIndex) committed = true;
		onChoose?.(index);
	}

	/**
	 * Choosing a reading, by click or by the keyboard. UNLIKE `chooseColumn`, re-choosing the
	 * retained reading always commits: 7j rules that assumed → confirmed is a value change, not a
	 * no-op, so it must be able to make a session's close announce.
	 */
	function chooseReading(order: 'day-first' | 'month-first') {
		committed = true;
		onChooseReading?.(order);
	}

	function close() {
		onClose?.(committed);
	}

	const READING_ORDER = ['day-first', 'month-first'] as const;
	const DAY_FIRST_OPTION_ID = 'date-reading-option-day-first';
	const MONTH_FIRST_OPTION_ID = 'date-reading-option-month-first';

	/**
	 * The active option, roving over exactly two entries. Reset to the RETAINED reading whenever
	 * step 2 becomes current, so a screen reader landing on the list for the first time in a session
	 * hears the answer that is already assumed or confirmed, per 7j's own transcript.
	 */
	let activeReadingIndex = $state(0);
	$effect(() => {
		if (effectiveStep === 'reading' && dateReading) {
			activeReadingIndex = READING_ORDER.indexOf(dateReading.retained);
		}
	});

	const activeReadingId = $derived(
		READING_ORDER[activeReadingIndex] === 'day-first' ? DAY_FIRST_OPTION_ID : MONTH_FIRST_OPTION_ID
	);

	/**
	 * Arrow keys move the active option AND select it in the same gesture (7j: "selection follows
	 * focus... which is also what applies it"). Clamped, not wrapped, matching `AccountPicker`'s own
	 * convention and its stated reason: wrapping past an end silently moves a user to the other end
	 * of a list they cannot see all of. Enter/Space re-fire the active option, which is how a
	 * keyboard user confirms the retained reading without moving away from it and back.
	 */
	function handleReadingKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			const next = Math.min(activeReadingIndex + 1, READING_ORDER.length - 1);
			if (next === activeReadingIndex) return;
			activeReadingIndex = next;
			chooseReading(READING_ORDER[next]);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			const next = Math.max(activeReadingIndex - 1, 0);
			if (next === activeReadingIndex) return;
			activeReadingIndex = next;
			chooseReading(READING_ORDER[next]);
		} else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			chooseReading(READING_ORDER[activeReadingIndex]);
		}
	}

	/**
	 * The two option roots, grabbed through a wrapper so `aria-activedescendant` can reference a
	 * REAL id on the actual `role="option"` element. `DateReadingCard` deliberately takes no `id`
	 * prop (see its own docstring: it is `ColumnCard`'s sibling species and neither takes one job
	 * the caller already owns), so the id is assigned imperatively onto its rendered root rather
	 * than threaded through a prop that does not exist. Each wrapper renders exactly one child and
	 * is never reordered, so `firstElementChild` is stable across re-renders.
	 */
	let dayFirstWrapperEl = $state<HTMLElement | null>(null);
	let monthFirstWrapperEl = $state<HTMLElement | null>(null);
	$effect(() => {
		const optionEl = dayFirstWrapperEl?.firstElementChild;
		if (optionEl) optionEl.id = DAY_FIRST_OPTION_ID;
	});
	$effect(() => {
		const optionEl = monthFirstWrapperEl?.firstElementChild;
		if (optionEl) optionEl.id = MONTH_FIRST_OPTION_ID;
	});

	/**
	 * Focus at the step change (7d): the NEW title, an `h2 tabindex="-1"`, exactly as on open — and
	 * ONLY at a change. The initial open is left to each variant's existing mechanism (`BottomSheet`'s
	 * `initialFocus="panel"` for `sheet`, nothing new for `anchored`), so this effect fires solely on
	 * the transition captured by `previousStep`/`previousOpen`: a step differing from the PRIOR tick
	 * while the sheet was ALREADY open in that prior tick. Two plain variables rather than `$state`,
	 * because they exist only for this effect to compare against itself and must not themselves
	 * retrigger it.
	 *
	 * No live announcement accompanies this: the retitled `h2` receiving focus IS the announcement,
	 * and a live region speaking at the same time would pre-empt it — the same "focus return wins"
	 * rule `ColumnDesignationScreen` already applies to its own row-designation announcement.
	 */
	let headingEl = $state<HTMLElement | null>(null);
	let previousStep: 'columns' | 'reading' | null = null;
	let previousOpen = false;
	$effect(() => {
		const currentStep = effectiveStep;
		const isOpen = open;
		if (isOpen && previousOpen && previousStep !== null && previousStep !== currentStep) {
			headingEl?.focus();
		}
		previousStep = isOpen ? currentStep : null;
		previousOpen = isOpen;
	});

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
			// Undefined rather than a zero when the file carries no counts: a card that says
			// « 0 valeurs » about a column it has not measured is worse than one that says nothing.
			coverage: file.coverage
				? { filled: file.coverage[index] ?? 0, total: file.rowCount }
				: undefined,
			forRole: role,
			marker: markerFor(index),
			heldByRole: roleHolding(assignment, index) ?? undefined,
			headerUnreadable: file.hasHeaderRow && (file.headers[index] ?? '').trim() === '',
			selected: index === designatedIndex,
			unavailable: isUnavailableFor(assignment, role, index),
			id: `column-option-${index}`,
			onSelect: () => chooseColumn(index)
		};
	}
</script>

{#snippet pickerBody()}
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

	<!--
		OUT OF `role="listbox"`, and a sibling ABOVE it in the same scrolling container (Planche 5d).

		A listbox's children must be options. A switch is not one, and the bare TapLink that used to
		sit here was not one either: the listbox was announcing one option too many, and its count is
		exact again. Not one picker item is redrawn.

		Above, because the control does not modify one card but the TITLE OF ALL OF THEM. The Colonnes
		plate had that right; what is corrected is the role and the place in the accessibility tree,
		not the storey. Placing it under the list would make the user scroll past fifteen cards whose
		titles are wrong to reach the control that fixes them.

		The label lost its verb, which is the repair. « La première ligne contient des données » is a
		sentence true or false according to a state it does not show: the reader sees an action and
		gets a value. Brique 6c separates them and writes the consequence underneath, which is the only
		protection against the silently eaten first transaction.
	-->
	<div class="px-5 pt-3.5">
		<SwitchRow
			label={m.import_columns_first_row_label()}
			valueLabel={[
				m.import_columns_first_row_value_data(),
				m.import_columns_first_row_value_headers()
			]}
			checked={file.hasHeaderRow}
			consequence={file.hasHeaderRow
				? m.import_columns_first_row_consequence_headers()
				: m.import_columns_first_row_consequence_data()}
			lockedReason={file.rowCount <= 1 ? m.import_columns_first_row_locked() : undefined}
			onChange={() => onToggleHeaderRow?.()}
		/>
	</div>
	<div class="mx-5 mt-3 mb-3 h-px bg-zinc-200" aria-hidden="true"></div>

	<div
		role="listbox"
		aria-label={title}
		class="flex flex-col gap-2 px-5"
		data-testid="column-listbox"
	>
		<!--
			EVERY CHILD OF THIS LISTBOX IS AN OPTION OR A GROUP OF OPTIONS, and that is a correction
			rather than a style. The three headings used to be bare `<p>` elements sitting directly
			inside `role="listbox"`, beside the `role="option"` cards. A paragraph is not in a
			listbox's content model, so an assistive technology walking the list is entitled to skip
			it or to report the structure as broken, and NOTHING failed: the headings rendered, the
			options rendered, every test passed. It was found by asking whether the children were
			options, which is the whole reason that assertion is written down.

			`role="group"` with the heading as its `aria-label`, rather than moving the headings out
			of the listbox: they scroll WITH their options, and a heading that stayed put while its
			group scrolled away would label the wrong rows. The visible `<p>` stays and is
			`aria-hidden`, because the group already carries the same words as its name and
			announcing them twice is worse than announcing them once.
		-->
		{#if designatedIndex !== null}
			<div role="group" aria-label={m.import_columns_group_designated()} class="contents">
				<p
					class="pt-1 text-[11px] font-bold tracking-[0.03em] text-zinc-500 uppercase"
					aria-hidden="true"
				>
					{m.import_columns_group_designated()}
				</p>
				<ColumnCard {...cardFor(designatedIndex)} />
			</div>
		{/if}

		{#if proposed.length > 0}
			<div role="group" aria-label={proposedGroupLabel} class="contents">
				<p
					class="pt-1 text-[11px] font-bold tracking-[0.03em] text-zinc-500 uppercase"
					aria-hidden="true"
				>
					{proposedGroupLabel}
				</p>
				{#each proposed as index (index)}
					<ColumnCard {...cardFor(index)} />
				{/each}
			</div>
		{/if}

		{#if rest.length > 0}
			<div
				role="group"
				aria-label={m.import_columns_group_all({ count: rest.length })}
				class="contents"
			>
				<p
					class="pt-1 text-[11px] font-bold tracking-[0.03em] text-zinc-500 uppercase"
					aria-hidden="true"
				>
					{m.import_columns_group_all({ count: rest.length })}
				</p>
				{#each rest as index (index)}
					<ColumnCard {...cardFor(index)} />
				{/each}
			</div>
		{:else if searchable && query.trim() !== ''}
			<!--
				A 48 px line INSIDE the listbox, not the brique-7 EmptyState: that is a page-level
				component with a round icon, and this is a message inside a list.

				`role="group"` for the same reason as the headings above: it is not an option, and the
				listbox's children may only be options or groups. Its own label is the message, so a
				screen reader in list mode is told why the list is empty rather than that it is.
			-->
			<div
				role="group"
				aria-label={m.import_columns_search_no_result()}
				class="flex h-12 items-center justify-between gap-3"
				data-testid="search-empty"
			>
				<span class="text-[13px] text-zinc-500" aria-hidden="true"
					>{m.import_columns_search_no_result()}</span
				>
				<TapLink onclick={() => (query = '')}>{m.import_columns_search_clear()}</TapLink>
			</div>
		{/if}

		<!--
			The white fade and home indicator area under the last card. `role="presentation"` as well
			as `aria-hidden`: the second removes it from the accessibility tree, and the first is what
			keeps it out of the listbox's content model for a checker reading the markup rather than
			the tree.
		-->
		<div class="h-14 shrink-0" role="presentation" aria-hidden="true"></div>
	</div>
{/snippet}

{#snippet readingBody()}
	<!--
		Step 2, plate 7b/7j. Same `role="listbox"` pattern as step 1's, single-select, over exactly
		two `DateReadingCard` options — never a radiogroup, see the class docstring.

		`aria-activedescendant`, not roving `tabindex`: `DateReadingCard` fixes its own root at
		`tabindex="-1"` (it is never itself a tab stop, by its own docstring), so the listbox is the
		one real tab stop and the active option is a pointer this component owns, assigned onto the
		card's rendered root by the two `$effect`s above.
	-->
	<div
		role="listbox"
		aria-label={title}
		tabindex="0"
		aria-activedescendant={activeReadingId}
		onkeydown={handleReadingKeydown}
		class="flex flex-col gap-2 px-5"
		data-testid="reading-listbox"
	>
		<div bind:this={dayFirstWrapperEl}>
			<DateReadingCard
				order="day-first"
				pairs={dayFirstPairs}
				current={dateReading?.retained === 'day-first'}
				onSelect={() => chooseReading('day-first')}
			/>
		</div>
		<div bind:this={monthFirstWrapperEl}>
			<DateReadingCard
				order="month-first"
				pairs={monthFirstPairs}
				current={dateReading?.retained === 'month-first'}
				onSelect={() => chooseReading('month-first')}
			/>
		</div>
	</div>

	<!--
		OUT OF the listbox, same reasoning as step 1's SwitchRow and search-empty group: a listbox's
		children must be options, and a TapLink is not one. A re-ask for step 1, never a back — see
		the class docstring's `step` section and 7d.

		ABSENT, not merely inert, when the caller has no columns to go back to. Plate 7l's auto-path
		reading offer omits `onChangeColumn` rather than passing a no-op: "no column list, no back
		to it", and a visible link that does nothing when pressed is the false affordance the plate
		forbids, not a harmless one. Found by a browser walk: no test asserted the link's absence,
		so an unconditional render survived the whole suite.
	-->
	{#if onChangeColumn}
		<div class="px-5 pt-2">
			<div class="flex h-12 items-center">
				<TapLink onclick={onChangeColumn}>{m.import_datesheet_change_column()}</TapLink>
			</div>
		</div>
	{/if}
{/snippet}

{#if variant === 'anchored'}
	<!--
		1280. The SAME listbox, anchored under the row that opened it, following `PeriodFilter` and
		`TagPicker`, which already ship this split. That is also why the trigger keeps its chevron:
		every disclosure trigger in this application pairs a down chevron with an anchored panel, and
		the glyph would have become a false claim only if the panel had stopped opening below the row.

		`role="dialog"` with a label, so the panel is announced as a thing that opened; the listbox
		inside keeps its own role, which is what a menu shell could not have offered.
	-->
	{#if open}
		<div
			bind:this={panelEl}
			role="dialog"
			tabindex={-1}
			aria-label={title}
			style:max-height={panelMaxHeight === null ? undefined : `${panelMaxHeight}px`}
			class="absolute top-full right-0 left-0 z-20 mt-1 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-3 shadow-lg"
			data-testid="column-picker-panel"
		>
			<div class="flex items-start justify-between gap-2 pb-3">
				<div class="min-w-0">
					<h2
						bind:this={headingEl}
						tabindex="-1"
						class="text-[15px] leading-5 font-bold text-zinc-900"
					>
						{title}
					</h2>
					<p class="text-[12.5px] leading-[18px] text-zinc-500">
						{subline}
					</p>
				</div>
				<IconButton label={m.import_columns_picker_close()} onclick={close}>
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
			{#if effectiveStep === 'reading'}
				{@render readingBody()}
			{:else}
				{@render pickerBody()}
			{/if}
		</div>
	{/if}
{:else}
	<BottomSheet {open} ariaLabel={title} onClose={close} initialFocus="panel">
		{#snippet header()}
			<div class="flex items-start justify-between gap-2 px-4 pb-3.5">
				<div class="min-w-0">
					<h2
						bind:this={headingEl}
						tabindex="-1"
						class="text-[17px] leading-[22px] font-bold text-zinc-900"
					>
						{title}
					</h2>
					<p class="text-[12.5px] leading-[18px] text-zinc-500">
						{subline}
					</p>
				</div>
				<IconButton label={m.import_columns_picker_close()} onclick={close}>
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

		{#if effectiveStep === 'reading'}
			{@render readingBody()}
		{:else}
			{@render pickerBody()}
		{/if}
	</BottomSheet>
{/if}
