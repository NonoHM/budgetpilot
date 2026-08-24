<script lang="ts">
	/**
	 * The account a statement belongs to, chosen before the columns are designated.
	 *
	 * ## Why this is not `RoleRow`, which is the first question a reader will ask
	 *
	 * It looks like one and it is not one. `RoleRow` takes `role: MappingRole`, a CLOSED union of
	 * the four column roles, and the plate verifies that closure as a constraint it holds rather
	 * than as an accident: « Quatre rôles, ensemble fermé. Tenu. Le compte n'est pas un rôle : il
	 * est lu avant la correspondance, comme le préambule d'un fichier. » Widening `MappingRole` to
	 * carry an account would break the one thing that check exists to protect, and a column named
	 * `Compte` in an export must still appear in the columns list and stay ignored.
	 *
	 * The states differ too, and not cosmetically. `RoleRow` has `empty | ambiguous | designated |
	 * vacated | missingColumn | recap`, which are facts about a COLUMN. This row has `ok | todo |
	 * error`, which are facts about a CHOICE. Folding them would need a union of nine members whose
	 * halves can never co-occur, which is the shape that makes a component impossible to reason
	 * about.
	 *
	 * **What IS shared is every measurement**, deliberately and with no new trait: 68 px at 390 and
	 * 56 at 1280, the chevron `aria-hidden` INSIDE the button so the whole row is one target and one
	 * tab stop, press and open both `zinc-100` with the press easing over 120 ms and the open
	 * instantaneous, no `:hover` at 390. The plate calls this « un quatrième usage sans trait
	 * nouveau » of a brique that is used four times and registered zero, and that is exactly what it
	 * is: a fourth usage, not a fifth pattern.
	 *
	 * ## The hint is a DESCRIPTION and the value is in the NAME, and the split is load bearing
	 *
	 * The accessible name is « Compte, BP · Compte courant ». The provenance line
	 * (« IBAN ···4417 lu dans le fichier ») is linked by `aria-describedby` and never enters the
	 * name, because a name that carried it would announce the whole sentence on every focus.
	 *
	 * The inverse mistake is the dangerous one and it is in the panel rather than here: an OPTION's
	 * second line must go INTO its accessible name, because a description can be switched off in a
	 * screen reader's settings, and switching it off there would remove the only thing separating
	 * two accounts at one bank. Same two lines, opposite treatment, for the same reason: what the
	 * user must not lose is what tells two things apart.
	 *
	 * ## There is no disabled state and a greyed row is a defect
	 *
	 * Recorded because a future contributor will add one for completeness. The primary is never
	 * disabled for invalidity either: pressing it with no account chosen REVEALS the error, scrolls
	 * this row into view and puts focus on it. A disabled control explains nothing and cannot be
	 * asked why.
	 */
	import * as m from '$lib/paraglide/messages';

	let {
		state = 'todo',
		value,
		hint,
		onOpen,
		expanded = false,
		panelId,
		busy = false
	}: {
		/** `ok` a choice is made, `todo` none yet, `error` the primary was pressed without one. */
		state?: 'ok' | 'todo' | 'error';
		/** The account's display name. Absent in `todo` and `error`. */
		value?: string;
		/** The provenance line. Linked by `aria-describedby`, never part of the name. */
		hint?: string;
		onOpen?: () => void;
		expanded?: boolean;
		panelId?: string;
		/** The import is in flight: the row goes inert and stays readable. */
		busy?: boolean;
	} = $props();

	const hintId = $derived(hint ? `account-row-hint-${panelId ?? 'default'}` : undefined);

	/**
	 * « Compte, BP · Compte courant » when there is one, « Compte » alone when there is not.
	 *
	 * The trailing "bouton" and "liste déroulante" are the ROLE and the popup type, contributed by
	 * the assistive technology from `aria-haspopup`. Writing either into the label announces it
	 * twice.
	 */
	const accessibleName = $derived.by(() => {
		// The ERROR sentence enters the NAME, and nothing else ever does.
		//
		// USER RULING, 2026-08-23, recorded as a deviation from 6h: `aria-invalid` is dropped. ARIA
		// 1.2 does not list it as supported on `role=button`, so it is an attribute a screen reader
		// may legitimately ignore, and an attribute that may be ignored is a control that reads as
		// present and does nothing. Dropping it leaves the error carried by the rose ground and by
		// the hint alone, and a hint is a DESCRIPTION, which a screen reader's verbosity setting can
		// switch off. So the error moves into the name, where no setting reaches it.
		//
		// This is the plate's own doctrine, applied one surface further than the plate applied it:
		// what the user must not lose is what tells two states apart, so it goes in the name. It is
		// the same argument that puts an OPTION's second line in its name rather than in a
		// description, and the opposite treatment of the ordinary provenance hint, which is genuinely
		// supplementary and stays a description.
		if (state === 'error' && hint) {
			return `${m.import_account_row_label()}, ${hint}`;
		}
		return value ? m.import_account_row_aria({ account: value }) : m.import_account_row_label();
	});
</script>

<button
	type="button"
	class="flex h-[68px] w-full items-center gap-3 rounded-xl px-4 text-left
		transition-colors lg:h-[56px]
		{state === 'error' ? 'bg-rose-50' : 'bg-white active:bg-zinc-100 lg:hover:bg-zinc-50'}
		{expanded ? 'bg-zinc-100' : ''}
		{busy ? 'pointer-events-none opacity-45' : ''}
		focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-4 focus-visible:ring-offset-zinc-400 focus-visible:outline-none"
	aria-haspopup="listbox"
	aria-expanded={expanded}
	aria-controls={panelId}
	aria-label={accessibleName}
	aria-describedby={hintId}
	aria-busy={busy ? 'true' : undefined}
	onclick={onOpen}
>
	<span class="flex min-w-0 flex-1 flex-col gap-1 lg:gap-0.5">
		<span class="truncate text-[13.5px] font-semibold text-zinc-900">
			{#if value}
				{value}
			{:else}
				<!-- Real text in zinc-500, never a `placeholder` attribute: it is read out, it is
				     contrasted, and it does not disappear the moment anything is typed. -->
				<span class="font-normal text-zinc-500">{m.import_account_row_placeholder()}</span>
			{/if}
		</span>
		{#if hint}
			<!-- zinc-500 and never zinc-400: at 11.5 px zinc-400 fails contrast, and zinc-500 on
			     white is about 4.8:1 with no margin to give away. -->
			<span id={hintId} class="truncate text-[11.5px] text-zinc-500">{hint}</span>
		{/if}
	</span>
	<!-- Inside the button and `aria-hidden`. A separate chevron button would double the tab stops
	     for one action and give assistive technology two names for one thing. -->
	<svg
		class="size-4 shrink-0 text-zinc-400 transition-transform {expanded ? 'rotate-180' : ''}"
		viewBox="0 0 16 16"
		fill="none"
		aria-hidden="true"
	>
		<path
			d="M4 6l4 4 4-4"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	</svg>
</button>
