<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import ColumnDesignationScreen from '$lib/components/import/ColumnDesignationScreen.svelte';
	import type { PageData } from './$types';

	/**
	 * « Voir les colonnes », the plate's §3.7 recap, reached from an import on `/imports`.
	 *
	 * This page is deliberately thin, like `/import/columns`: the screen is the same component in
	 * its `readOnly` mode, and everything that decides anything is in the load. What this route adds
	 * is the one thing that mode could not have: somewhere to be opened from.
	 */
	let { data }: { data: PageData } = $props();

	let wide = $state(false);
	$effect(() => {
		const query = window.matchMedia('(min-width: 1024px)');
		wide = query.matches;
		const update = (event: MediaQueryListEvent) => (wide = event.matches);
		query.addEventListener('change', update);
		return () => query.removeEventListener('change', update);
	});

	const memorisedOn = $derived(
		new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'long' }).format(
			new Date(data.memorisedAt)
		)
	);
	const memorised = $derived(
		data.useCount === 1
			? m.import_columns_memorised_one({ date: memorisedOn, count: data.useCount })
			: m.import_columns_memorised_many({ date: memorisedOn, count: data.useCount })
	);
</script>

<svelte:head>
	<title>{m.import_columns_recap_page_title()}</title>
</svelte:head>

<!--
	Under the card rather than above it, so the screen's own heading is the first thing read, and
	INSIDE the screen rather than after it: measured on the journey, a paragraph rendered after this
	component lands below the frame's border at 1280, on a different centring axis from the card it
	qualifies, and behind the tab bar at 390. A sentence about the four rows is read with them.

	The memorisation line is the plate's, and it is repeated here from `/imports` because this is the
	screen where the user decides whether the correspondance is right: how long it has been repeating
	is part of that decision.

	The sentence under it is NOT the plate's any more. It read « Ce que chaque rôle a lu, et la valeur
	que cet import en a tirée », which is a claim about the past made from a row that only knows the
	present: `+page.server.ts` reaches the mapping through `batch.columnMapping`, so a correspondance
	corrected since draws the NEW column names on the OLD import's page while its transactions still
	hold what the old reading produced. Finding A8.

	The caption is only half the repair and it is the half that could not have been enough alone: the
	pairing it would have denied is inside the card, one line above it, so the rows state the two
	facts separately and this sentence says which of them is current. **The snapshot is #379** and it
	stays the only thing that would make an old batch's page truthful rather than merely honest about
	what it does not know. `updatedAt` cannot stand in for it: `recordColumnMappingUse` bumps it on
	every USE, so it cannot separate a correspondance that was edited from one that was merely used
	again.
-->
{#snippet caption()}
	<p class="text-[12.5px] leading-[17px] text-zinc-500">{memorised}</p>
	<p class="mt-1 text-[12.5px] leading-[17px] text-zinc-500">
		{m.import_columns_recap_explanation()}
	</p>
{/snippet}

<main class="min-h-dvh w-full bg-zinc-50">
	<ColumnDesignationScreen
		file={data.file}
		initialAssignment={data.assignment}
		readOnly
		modifyAsksForFile
		recapCaption={caption}
		{wide}
		onCancel={() => goto(resolve('/imports'))}
		onModify={() =>
			goto(
				resolve(
					// BOTH ids. The correspondance says which designation reopens; the batch says which
					// import the correction replaces, and without it the corrected rows land beside the
					// wrong ones and every total counts twice until the user finds the old import and
					// deletes it by hand.
					`/import?correct=${encodeURIComponent(data.mappingId)}&batch=${encodeURIComponent(data.batchId)}` as `/import?${string}`
				)
			)}
	/>
</main>
