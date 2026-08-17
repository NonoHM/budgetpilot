<script lang="ts">
	// A labelled binary choice.
	//
	// ## Referential gap, named rather than invented around (#378)
	//
	// The component referential carries 16 briques and the V2 additions carry three more, one of
	// which is a calendar cell. None of the nineteen is a labelled binary control. Brique 1 carries
	// a toggle role and is icon-only by its own accessibility clause, and this control exists
	// precisely to carry words: the whole reason it is here is that a delete has to say what it
	// destroys, which an icon cannot do.
	//
	// NOT built on the « Ne pas mémoriser » text-link pattern. A blind usability session measured
	// that pattern: the tester could not tell whether it was a toggle currently off or a one-shot
	// action, and that ambiguity on a control that DELETES is the failure this component exists to
	// avoid.
	//
	// If #378 lands with different values, this is corrected by a few numbers and nothing else.
	//
	// ## The 44 px floor is the V2 precedence clause, not a preference
	//
	// « Au point de rupture mobile, le plancher de 44 px l'emporte sur toute valeur desktop plus
	// petite, sans exception négociable écran par écran. » The clause exists because three triggers
	// shipped at 40 and a fourth at 36, each defensible on its own screen. So the row carries the
	// floor rather than a value chosen here.
	//
	// ## No tint
	//
	// The referential reserves colour for the destructive, the late, and a tag's identity. This
	// control deletes, which sounds like the first, but the deletion is the repair the user came
	// for and they have done nothing wrong. Zinc and black, and the WORDS carry the weight.
	let {
		name,
		label,
		note,
		checked = $bindable()
	}: {
		/** Posted twice: once as the checkbox, once as the hidden companion below. */
		name: string;
		label: string;
		/** What ticking it costs, when there is something to say. Absent, nothing is rendered. */
		note?: string;
		checked: boolean;
	} = $props();

	const noteId = $derived(note ? `${name}-note` : undefined);
</script>

<div class="flex flex-col gap-1">
	<label class="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-zinc-900">
		<!--
			DELIBERATELY UNNAMED. An unchecked checkbox is simply absent from a form submission, which
			reads server side as « the field was never added » rather than as « the user said no »,
			and on a control that decides a DELETE those two must not be the same value. Naming both
			this and the hidden field below would also make the answer depend on their DOM order,
			since `formData.get` returns the first entry for a name. So the checkbox is the affordance
			and the hidden field is the answer, one name, one value, always present.
		-->
		<input
			type="checkbox"
			bind:checked
			aria-describedby={noteId}
			class="size-4 shrink-0 rounded border-zinc-300 text-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none"
		/>
		<span>{label}</span>
	</label>
	<input type="hidden" {name} value={checked ? 'true' : 'false'} />
	{#if note}
		<p id={noteId} class="pl-7 text-xs text-zinc-500">{note}</p>
	{/if}
</div>
