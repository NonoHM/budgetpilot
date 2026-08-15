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

<main class="min-h-dvh w-full bg-zinc-50">
	<ColumnDesignationScreen
		file={data.file}
		initialAssignment={data.assignment}
		readOnly
		{wide}
		onCancel={() => goto(resolve('/imports'))}
		onModify={() =>
			goto(resolve(`/import?correct=${encodeURIComponent(data.mappingId)}` as `/import?${string}`))}
	/>
	<!--
		Under the card rather than above it, so the screen's own heading is the first thing read. The
		sentence is the plate's, and it is repeated here from `/imports` because this is the screen
		where the user decides whether the correspondance is right: how long it has been repeating is
		part of that decision.
	-->
	<div class="mx-auto max-w-3xl px-4 pb-8 lg:px-8">
		<p class="text-[12.5px] text-zinc-500">{memorised}</p>
		<p class="mt-1 text-[12.5px] text-zinc-500">{m.import_columns_recap_explanation()}</p>
	</div>
</main>
