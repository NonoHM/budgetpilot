<script lang="ts">
	// A minimal host so the spec can submit a real <form> containing a real Combobox — the seam the
	// component alone cannot exercise (CLAUDE.md: a trigger and its target were never in one test).
	import Combobox from '../Combobox.svelte';

	let {
		options,
		required = false,
		onsubmitted
	}: {
		options: { value: string; label: string }[];
		required?: boolean;
		onsubmitted: () => void;
	} = $props();
</script>

<form
	onsubmit={(event) => {
		event.preventDefault();
		onsubmitted();
	}}
>
	<Combobox {options} {required} name="category" ariaLabel="Catégorie" />
	<button type="submit">Enregistrer</button>
</form>
