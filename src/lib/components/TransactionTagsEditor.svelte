<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import Button from './Button.svelte';
	import TagPicker from './ui/TagPicker.svelte';
	import AlertBanner from './AlertBanner.svelte';
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
		action,
		enhanceSubmit,
		error,
		dirty = $bindable()
	}: {
		transactionId: string;
		tags: Array<{ id: string; name: string; colorToken: string }>;
		allTags: Array<{ id: string; name: string; colorToken: TagColorToken }>;
		/**
		 * Where this form posts, supplied by the page rather than written here, and REQUIRED so that
		 * a future caller has to answer the question rather than inherit an answer.
		 *
		 * A bare `action="?/saveTags"` posts to `/transactions?/saveTags`, and that query string is
		 * the whole query string: `selected` goes with it, so the panel this editor lives in is gone
		 * by the time the response renders, taking the refusal below with it. The page builds this
		 * through the one builder its four panel forms share.
		 */
		action: string;
		/**
		 * What the page does with the answer. Also the page's decision rather than this component's:
		 * without it the browser submits natively and navigates, which is a full page load even when
		 * the action URL carries the selection.
		 */
		enhanceSubmit: SubmitFunction;
		error?: string;
		/**
		 * Whether this editor holds an unsaved change, mirrored out for the page's navigation guard.
		 *
		 * Exposed rather than recomputed on the page: the dirty check below is deliberately written
		 * ONCE so the desktop panel and the mobile sheet cannot drift, which is the same reason this
		 * component exists at all. A second copy on the page would be a second chance to disagree
		 * about what "unsaved" means — and the guard would then let real work be discarded silently.
		 */
		dirty?: boolean;
	} = $props();

	// Unique per instance: this editor is mounted twice at once (desktop panel and mobile sheet),
	// and a duplicated id would point both Save buttons at whichever hint the DOM resolved first.
	const instanceId = $props.id();
	const hintId = `tags-save-hint-${instanceId}`;

	// Writable $derived, not $state + $effect: this stays live off `tags` (a different row selected,
	// or the load re-running for the SAME transaction after Save or after a bulk action elsewhere
	// always hands down a fresh array reference) while TagPicker's `bind:selected` can still
	// reassign it locally as the user picks and removes tags, the same reset behaviour
	// manualCategoryValue/manualNatureValue get from +page.svelte's own $effect.
	//
	// The refresh used to be a full-page POST reload. It is `enhance`'s `invalidateAll` now, and the
	// difference matters in the direction that helps: that call only runs on SUCCESS
	// (@sveltejs/kit's own fallback_callback), so a REFUSED save leaves `tags` untouched and the
	// selection the user was refused for survives beside the sentence explaining the refusal. Under
	// the reload it was discarded, and the sentence was discarded with it.
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

	// The one write to the bindable. `$effect` rather than assigning inside the `$derived`, because
	// a derived must stay pure — writing a prop from inside one is how a state_unsafe_mutation
	// crash is earned. Guarded on inequality so a re-render that changes nothing does not push a
	// write up into the parent's state and back down again.
	$effect(() => {
		if (dirty !== isDirty) dirty = isDirty;
	});
</script>

<form class="grid" method="POST" {action} use:enhance={enhanceSubmit}>
	<!-- fieldset + legend rather than section + heading: this is a group of form controls, and the
	     design names the structure explicitly. The legend is what ties the group to its name for a
	     screen reader; a heading beside the controls does not. -->
	<fieldset class="rounded-xl border border-zinc-200 p-3">
		<legend class="px-1 text-sm font-semibold">{m.tags_heading()}</legend>
		<input type="hidden" name="transactionId" value={transactionId} />
		<div class="mt-1 grid gap-2">
			<TagPicker options={allTags} bind:selected name="tags" ariaLabel={m.tags_heading()} />
			{#if selected.length > 0}
				<!-- Static help line, not aria-hidden, not focusable: read in document order right
				     after the chip group it documents. Gated on there being at least one chip — with
				     none there is nothing to explain, and the design is explicit that the group and
				     this line disappear together, silently, when the last chip goes. -->
				<p class="text-xs text-zinc-500">{m.tags_chips_help_remove()}</p>
			{/if}
			<!--
				The refusal, in the form it belongs to and beside the picker it is about, matching the
				three sibling sections in this panel. `AlertBanner variant="error"` rather than a rose
				line because it carries `role="alert"`: the panel now survives the submit, so a refused
				save changes nothing else on screen and the announcement is the only thing separating it
				from one that worked.

				What can arrive here is ONE sentence in practice, and not the one it looks like.
				`saveTags` refuses on the tag cap and on a missing row; the cap is unreachable from
				this editor, because TagPicker's own `atMax` stops the eleventh selection before a
				submit exists (ui/TagPicker.svelte:114,162,171,178). So the reachable answer is the
				row having gone between the panel rendering and the submit, which is a second tab or
				a stale panel, which is precisely the refusal a user cannot predict and therefore the
				worst one to discard.
			-->
			{#if error}
				<AlertBanner variant="error" size="sm">{error}</AlertBanner>
			{/if}
			<div class="flex flex-wrap gap-2">
				<!-- softDisabled, not disabled. The reason Save is inactive ("nothing has changed") is
				     something the user has to read to act on, and a natively disabled button leaves the
				     tab order and announces nothing. The label stays unchanged, per the design. -->
				<Button
					type="submit"
					size="sm"
					softDisabled={!isDirty}
					aria-describedby={isDirty ? undefined : hintId}
				>
					{m.common_save()}
				</Button>
			</div>
			{#if !isDirty}
				<p id={hintId} class="text-xs text-zinc-500">{m.tags_editor_save_hint()}</p>
			{/if}
		</div>
	</fieldset>
</form>
