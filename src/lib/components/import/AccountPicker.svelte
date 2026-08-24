<script lang="ts" module>
	export interface AccountPickerOption {
		id: string;
		/** The account's display name. Unique per user, editable, never a lookup key. */
		name: string;
		/**
		 * The last four characters of the IBAN or account number, never the full identifier.
		 *
		 * `null` when the files have never carried one, which is a real and ordinary state rather
		 * than missing data: the option then reads « Aucun identifiant dans les fichiers ».
		 */
		discriminant?: string | null;
		transactionCount: number;
	}

	let idCounter = 0;
</script>

<script lang="ts">
	import * as m from '$lib/paraglide/messages';

	/**
	 * The panel the account row opens.
	 *
	 * ## This is brique 10, not a new brique, and the plate settles that rather than this file
	 *
	 * 6f audits the assembly and registers NOTHING: « Le sélecteur de compte est un assemblage de
	 * deux choses existantes. » The trigger is the designation row, whose fourth usage this is and
	 * which adds no new trait; the panel is brique 10 « existant, tel quel », with two CLAUSES to
	 * inscribe on it: the two-line option and the pinned footer action.
	 *
	 * A dedicated « AccountPicker » brique was considered and **rejected in the plate itself**:
	 * « Ce serait la brique 10 plus une rangée. Une brique par écran est précisément la dérive que
	 * le référentiel a été écrit pour arrêter. » This file honours that ruling rather than
	 * contradicting it: it registers no brique. It is the same kind of thing `ColumnPicker.svelte`
	 * already is on this very screen, whose own docstring calls itself « a brique-15 bottom sheet
	 * holding a brique-10 listbox » — a file composing briques, inscribing none.
	 *
	 * ## Why not `FilterDropdown.svelte`, which IS the other three usages of brique 10
	 *
	 * Measured rather than assumed: `<FilterDropdown` occurs exactly THREE times in `src/`, and the
	 * plate says « les trois autres Dropdown du produit ». So that component is brique 10's other
	 * incarnation, and reusing it was the first thing tried.
	 *
	 * It fuses a trigger and a panel, and the trigger is the half that cannot be reused. Its own
	 * comment says so: « 34px is the referential's DESKTOP control height, and this component is
	 * desktop-only … If it is ever rendered below `lg`, this needs `h-11 lg:h-[34px]` and a fresh
	 * measurement. » The account row is 68 px at 390 and its panel is sized at BOTH widths by 6h
	 * (358 at 390, 372 at 1280, in both cases the trigger's own width). Widening the one component
	 * whose comment forbids that width is the wrong axis to widen.
	 *
	 * It also carries filter semantics a statement's account has no meaning for: a « Toutes » return
	 * row its docstring pins as « not conditional: it is there even with a single option », a clear
	 * « × », and per-option counts in the trailing slot this design gives to a tick. A statement
	 * comes from one account and from exactly one; there is nothing to return to.
	 *
	 * **The honest follow-up, recorded rather than done here:** the panel body of the two is now
	 * genuinely the same object, and extracting it so all four usages share one implementation is
	 * the change that would make the plate's « exemplaires plutôt qu'exceptionnels » true in code as
	 * well as in the référentiel. It touches the /transactions filter bar, whose e2e pins measured
	 * contrast values, so it is its own commit and not a fifth part of this one.
	 *
	 * `PeriodFilter.svelte` is the precedent for the split and states the rule this obeys: a SIBLING
	 * when the interaction model differs, a variant when it does not. Its model differs (free-text
	 * date inputs cannot be listbox options). This one's does not differ at all, which is exactly
	 * why its keyboard model below is FilterDropdown's, verbatim.
	 *
	 * ## The two clauses, and what each is for
	 *
	 * **The second line goes INTO the accessible name.** Not `aria-describedby`. A description can
	 * be switched off in a screen reader's settings, and switching it off here removes the only
	 * thing separating two accounts at one bank, which reconstitutes the repaired defect inside
	 * speech synthesis. This is the OPPOSITE treatment from the row's provenance hint, which is
	 * genuinely supplementary. Same two lines, opposite treatment, for one reason: what the user
	 * must not lose is what tells two things apart.
	 *
	 * **The footer action is outside `role="listbox"`.** A listbox's children must be options and
	 * this is not one, so counting it in would announce one destination too many. It is the exact
	 * structural move 5d already made on this screen when it lifted the header-row switch out of
	 * the columns listbox without touching a single item. Tab reaches it, arrows never do, and it
	 * is the panel's LAST tab stop.
	 *
	 * ## No search field, and the threshold is written down rather than intuited
	 *
	 * 6f: a user has two to eight accounts, and filtering eight lines is slower than reading them.
	 * Brique 14 exists and waits for a measurement above TWELVE accounts rather than for an
	 * intuition. `maxVisible` bounds the scroll, not the list.
	 */
	let {
		open = false,
		options,
		selectedId = null,
		panelId,
		maxVisible = 5,
		initialFocus = 'list',
		allowCreate = true,
		onChoose,
		onClose,
		onCreate
	}: {
		open?: boolean;
		options: readonly AccountPickerOption[];
		/** The account currently chosen, so the panel can open ON it rather than on the first. */
		selectedId?: string | null;
		/** Must match the row's `aria-controls`, so the trigger names the thing it opens. */
		panelId?: string;
		/**
		 * Options visible before the list scrolls. 6k's figure is 5, and it is a prop only so a test
		 * can reach the scrolling case without building a fixture of six accounts every time.
		 */
		maxVisible?: number;
		/**
		 * Where the focus lands when the panel opens.
		 *
		 * `list` is the ordinary case and stays the default. `footer` is the return from the create
		 * sheet: a user who cancelled a creation came FROM the footer action, and putting them back
		 * on the list would move them somewhere they did not leave. It is also what an empty panel
		 * gets whatever the caller asked for, because there is no list to focus and a focus call on
		 * nothing leaves the whole panel unreachable from the keyboard.
		 */
		initialFocus?: 'list' | 'footer';
		/**
		 * Whether this host can offer to create an account.
		 *
		 * True everywhere it has been used so far, and false on `/import`, where the account
		 * question is asked beside a refusal and the create SHEET is not mounted. The alternative
		 * was to render the action anyway and leave it inert, which is a dead control shipped inside
		 * the fix for a dead end.
		 *
		 * **This is a REFERENTIAL GAP wearing a prop.** The account question is a row, this panel, a
		 * create sheet and the focus choreography that makes the three one control, and that
		 * choreography lives inside `ColumnDesignationScreen.svelte` rather than in a brique of its
		 * own. `/import` is its second host, which is the point at which it should become one:
		 * copying the choreography is how three expressions of one rule end up agreeing by review.
		 * Recorded here rather than done, because extracting it means editing the designation screen,
		 * which the change that needed this does not otherwise touch.
		 */
		allowCreate?: boolean;
		onChoose?: (accountId: string) => void;
		onClose?: () => void;
		onCreate?: () => void;
	} = $props();

	idCounter += 1;
	const uid = `account-picker-${idCounter}`;

	let listEl = $state<HTMLElement | null>(null);
	let footerEl = $state<HTMLButtonElement | null>(null);
	let panelEl = $state<HTMLElement | null>(null);
	let activeIndex = $state(-1);

	const selectedIndex = $derived(options.findIndex((option) => option.id === selectedId));

	/**
	 * Focus enters the panel on the LISTBOX, which is what makes `aria-activedescendant` legal: the
	 * attribute has to sit on the focused element, and neither a `<button>` nor a `<li>` may carry
	 * it. The active row starts on the SELECTED option and not on the first, per 6k: opening on the
	 * first leaves the arrow keys somewhere the user did not put them, so a confirming press changes
	 * the value it was meant to confirm.
	 */
	$effect(() => {
		if (!open) {
			activeIndex = -1;
			return;
		}
		activeIndex = selectedIndex;
		// The empty panel forces the footer whatever was asked, because there is no list: a focus
		// call on null is silent, and the panel would open with the focus still outside it.
		if (allowCreate && (initialFocus === 'footer' || options.length === 0)) footerEl?.focus();
		else if (options.length > 0) listEl?.focus();
		// Nothing inside the panel can take the focus: no options, and no action because this host
		// cannot offer one. The panel itself does, so it is never opened with the focus left outside
		// it, which is a control the keyboard can neither reach nor leave. The empty list used to be
		// covered by forcing the footer, and `allowCreate: false` is what removes it from under that
		// guard.
		else panelEl?.focus();
	});

	const activeId = $derived(activeIndex >= 0 ? `${uid}-option-${activeIndex}` : undefined);

	/**
	 * The whole second line, as ONE catalogue string rather than a fragment joined here.
	 *
	 * The separator is copy: it sits between a masked identifier and a count, and a translator has
	 * to be able to see both sides of it. Composing it in the component would leave the catalogue
	 * holding two halves of a sentence neither of which reads as one.
	 */
	function secondaryOf(option: AccountPickerOption): string {
		if (!option.discriminant) return m.import_account_option_none();
		return option.transactionCount === 1
			? m.import_account_option_detail_one({
					fragment: option.discriminant,
					count: option.transactionCount
				})
			: m.import_account_option_detail_many({
					fragment: option.discriminant,
					count: option.transactionCount
				});
	}

	/** Both lines, because the second one may not be a description. See the docstring. */
	function nameOf(option: AccountPickerOption): string {
		return `${option.name}, ${secondaryOf(option)}`;
	}

	function choose(index: number): void {
		const option = options[index];
		if (!option) return;
		onChoose?.(option.id);
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			// Clamped, not modulo, following FilterDropdown: wrapping past the end silently moves the
			// user to the other end of a list they cannot see all of.
			activeIndex = Math.min(activeIndex + 1, options.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			activeIndex = Math.max(activeIndex - 1, 0);
		} else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			choose(activeIndex);
		} else if (event.key === 'Escape') {
			// Stopped ONLY while the panel is open, so a closed panel never swallows the screen's own
			// Escape. The value does not change: 6k's « Fermeture sans choix ».
			event.stopPropagation();
			onClose?.();
		}
	}
</script>

{#if open}
	<!--
		Absolutely positioned, and that is load bearing rather than stylistic. An in-flow panel is
		what silently ate a first-time user's first save for a whole chantier: pressing the mouse on
		a control below moves focus out, the panel closes, everything under it jumps up, and the
		mouse-up lands on whatever slid underneath. See the long comment at TagPicker.svelte:131.

		`left-0 right-0` rather than a width: 6h sizes the panel at the TRIGGER's own width at both
		widths (358 at 390, 372 at 1280), so it is expressed as the trigger's width rather than as
		two numbers that would have to be kept in step with the row by hand.

		radius 12, black border, 160 ms open: brique 10 unchanged, none of these values moves.
	-->
	<div
		bind:this={panelEl}
		id={panelId}
		tabindex="-1"
		data-testid="account-panel"
		class="absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-xl border border-zinc-900 bg-white
			motion-safe:animate-[fade-in_160ms_ease-out]"
	>
		{#if options.length > 0}
			<!--
				`--row-h` carries the two-line option's measured height so the scroll bound stays one
				expression rather than a pair of pixel literals per breakpoint. maxVisible + 0.5 is 6k's
				rule made arithmetic: the sixth option is HALF CUT and not hidden, because a clean edge
				at the fifth row is a claim that there are five accounts.
			-->
			<ul
				bind:this={listEl}
				role="listbox"
				tabindex="-1"
				aria-label={m.import_account_row_label()}
				aria-activedescendant={activeId}
				onkeydown={onKeydown}
				style:--row-h="56px"
				style:--rows={String(maxVisible + 0.5)}
				class="overflow-y-auto focus:outline-none lg:[--row-h:48px]"
				style:max-height="calc(var(--rows) * var(--row-h))"
			>
				{#each options as option, index (option.id)}
					<!--
						Keyboard interaction is handled entirely on the listbox through
						aria-activedescendant (WAI-ARIA APG, "Collection with aria-activedescendant"), so
						these rows are never independently focusable and no keydown handler applies here.
						Same pattern and same suppression as FilterDropdown's and TagPicker's option rows.
					-->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<li
						id="{uid}-option-{index}"
						role="option"
						aria-selected={option.id === selectedId}
						aria-label={nameOf(option)}
						class="flex h-14 cursor-pointer items-center gap-3 px-4 lg:h-12
							{index === activeIndex ? 'bg-zinc-100' : ''}"
						onmousedown={(event) => event.preventDefault()}
						onclick={() => choose(index)}
						onmouseenter={() => (activeIndex = index)}
					>
						<span class="flex min-w-0 flex-1 flex-col justify-center">
							<span class="truncate text-[13.5px] font-semibold text-zinc-900">{option.name}</span>
							<!--
								Never zinc-400: at 11.5 px it fails contrast. zinc-500 on white is about
								4.8:1, with no margin to give away.
							-->
							<span class="truncate text-[11.5px] text-zinc-500">{secondaryOf(option)}</span>
						</span>
						{#if option.id === selectedId}
							<!-- A check, not merely a zinc-100 ground: a ground alone is information
							     carried by colour. -->
							<svg
								class="size-4 shrink-0 text-zinc-500"
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
				{/each}
			</ul>
		{/if}

		<!--
			OUTSIDE the listbox and after it, so Tab reaches it last and the arrows never do. 48 px at
			both widths: 6h calls it the preferred value and says nothing compresses it. The 1 px rule
			is what separates an action from the options above it; with no options above, there is
			nothing to separate it from, which is the empty-panel cell.
		-->
		{#if allowCreate}
			<button
				bind:this={footerEl}
				type="button"
				class="flex h-12 w-full items-center gap-2 px-4 text-left text-[13.5px] font-semibold
				text-zinc-900 focus-visible:ring-2 focus-visible:ring-white
				focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-400 focus-visible:outline-none active:bg-zinc-100 lg:hover:bg-zinc-50
				{options.length > 0 ? 'border-t border-zinc-200' : ''}"
				onclick={() => onCreate?.()}
			>
				<svg
					class="size-4 shrink-0 text-zinc-500"
					viewBox="0 0 16 16"
					fill="none"
					aria-hidden="true"
				>
					<path
						d="M8 3.5v9M3.5 8h9"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
					/>
				</svg>
				{m.import_account_new()}
			</button>
		{/if}
	</div>
{/if}
