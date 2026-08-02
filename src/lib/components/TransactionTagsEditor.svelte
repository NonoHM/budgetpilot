<script lang="ts">
	import Button from './Button.svelte';
	import TagPicker from './ui/TagPicker.svelte';
	import type { TagColorToken } from '$lib/domain/tags';
	import * as m from '$lib/paraglide/messages';

	/**
	 * The tags section on a transaction, shared by the desktop detail panel and the mobile bottom
	 * sheet. Zero business-logic duplication, following the rule TransactionProposalCard.svelte
	 * states for the same reason: pasting this twice would give the two surfaces two independent
	 * dirty-checks and two independent chances to drift.
	 *
	 * Deliberately NOT mounted in TransactionFocusOverlay: that surface is classification triage,
	 * and a tag control there is noise on the one screen built for speed.
	 *
	 * Structurally identical to the manual category/nature sections it sits beside: a
	 * `<section class="rounded-xl border border-zinc-200 p-3">`, a heading, a POST form with a
	 * hidden transactionId, and a Save button gated on a dirty check so a no-op submit is never
	 * offered.
	 */
	let {
		transactionId,
		tags,
		allTags,
		error
	}: {
		transactionId: string;
		tags: Array<{ id: string; name: string; colorToken: string }>;
		allTags: Array<{ id: string; name: string; colorToken: TagColorToken }>;
		error?: string;
	} = $props();

	// Writable $derived, not $state + $effect: this stays live off `tags` (a different row
	// selected, or a full-page POST reload of the SAME transaction after Save or after a bulk
	// action elsewhere always hands down a fresh array reference) while TagPicker's `bind:selected`
	// can still reassign it locally as the user picks and removes tags, the same reset behaviour
	// manualCategoryValue/manualNatureValue get from +page.svelte's own $effect.
	let selected = $derived(tags.map((t) => t.name));

	// Order-independent: TagPicker's own selected-chip row does not promise to preserve the order
	// `tags` arrived in (removing then re-adding a tag moves it to the end), so a same-set-different-
	// order selection must not read as dirty.
	const isDirty = $derived.by(() => {
		if (selected.length !== tags.length) return true;
		const initial = tags.map((t) => t.name).sort();
		const current = [...selected].sort();
		return initial.some((name, i) => name !== current[i]);
	});
</script>

<section class="rounded-xl border border-zinc-200 p-3">
	<h3 class="text-sm font-semibold">{m.tags_heading()}</h3>
	<form class="mt-3 grid gap-2" method="POST" action="?/saveTags">
		<input type="hidden" name="transactionId" value={transactionId} />
		<TagPicker options={allTags} bind:selected name="tags" ariaLabel={m.tags_heading()} />
		{#if error}
			<p class="text-xs text-rose-600">{error}</p>
		{/if}
		<div class="flex flex-wrap gap-2">
			<Button type="submit" size="sm" disabled={!isDirty}>{m.common_save()}</Button>
		</div>
	</form>
</section>
