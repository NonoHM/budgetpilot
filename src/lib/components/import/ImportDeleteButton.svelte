<script lang="ts">
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import * as m from '$lib/paraglide/messages';

	/**
	 * The ONE destructive control of an import card, at both widths (Planche 5e, reported from the
	 * delete plate without reopening it).
	 *
	 * ## Three states circulated for one action
	 *
	 * Red words on desktop, a « ··· » disclosure in the tested build, and a 32 px bordered red bin in
	 * the design file. Brique 1's own « Remplace » section names imports, bin included, so the mobile
	 * chrome was applying the referential: it is the desktop, with its word, that had stayed on a
	 * drawing the referential already replaced. The divergence was real and on the side that looked
	 * conformant.
	 *
	 * ## The accessible name is the piece that counts
	 *
	 * « Supprimer releve.csv » named a disclosure that deleted nothing, and BOTH lookalike cards
	 * carried it, so assistive technology could not tell them apart. The name is now verb, object
	 * type, discriminant: « Supprimer l'import du 1 juillet 2026 à 10:59 ».
	 *
	 * The timestamp is the discriminant because it is the one attribute two candidates do not share,
	 * and it is also the list's sort key, so the name follows the order the user sees. The file name
	 * is what they share; the profile is shared too in the case that hurts, since two imports of one
	 * statement come from one profile; the counters are already read by the card just above; and the
	 * position changes on every new import, so a name built from it designates a different object
	 * between visits and is not a name.
	 *
	 * `namedAt` arrives ALREADY FORMATTED, from the page's single formatter, so the name and the
	 * visible text can never diverge. That page renders to the SECOND rather than the minute, and it
	 * was measured: a repair happens minutes after the import that went wrong, so the two land in the
	 * same minute often enough that minute precision names both candidates.
	 *
	 * ## Icon only is admissible ON A CONDITION, and the condition is registered
	 *
	 * It holds because the confirmation is compulsory and carries the words. If the modal is ever
	 * dropped for fluency, this argument falls with it and the visible label is due again. That is a
	 * dependency rather than a preference, and it is recorded in
	 * `docs/reference/design-referential.md`.
	 *
	 * ## No tooltip on desktop
	 *
	 * A « Supprimer cet import » bubble on hover would be information reserved to the desktop, which
	 * is a new divergence born exactly the way the first one was. If the glyph needs a word to be
	 * understood then it needs one everywhere, and that reopens the decision above rather than
	 * patching one surface.
	 */
	let {
		namedAt,
		onPress
	}: {
		/** The import's timestamp, formatted by the page that owns the identity. */
		namedAt: string;
		onPress: () => void;
	} = $props();
</script>

<IconButton
	tone="danger"
	label={m.imports_delete_aria({ date: namedAt })}
	onclick={onPress}
	class="rounded-xl"
>
	<!--
		18 px, stroke 1.7, from the plate. The bin is the only destructive glyph of the icon set: it
		designates nothing else anywhere, which is what carries the meaning on a monochrome screen and
		is why the resting state needs no tint.
	-->
	<svg
		class="h-[18px] w-[18px]"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="1.7"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<path
			d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"
		/>
	</svg>
</IconButton>
