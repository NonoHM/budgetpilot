<script lang="ts">
	import type { PageData } from './$types';
	import { goto } from '$app/navigation';
	import Button from '$lib/components/Button.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import { cardBase } from '$lib/styles';
	import * as m from '$lib/paraglide/messages';

	let { data }: { data: PageData } = $props();

	// The browser's own origin, byte-identical to what it will send as the Origin header on the
	// first form submission. Empty during SSR, filled on mount: the server cannot know it, which is
	// the entire reason this page exists.
	let arrived = $state('');

	$effect(() => {
		const here = window.location.origin;
		// The same comparison that brought the visitor here is what keeps them here. The server
		// cannot tell a healthy instance from a broken one, so this is the only place the route can
		// be guarded: linked or typed at an instance whose origins agree, it goes away.
		if (here === data.expected) {
			void goto('/');
			return;
		}
		arrived = here;
	});

	// The app already shows a value an operator has to copy this way (settings, the TOTP secret).
	const valueBlock =
		'rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm break-all text-zinc-900';
</script>

<svelte:head>
	<title>{m.origin_mismatch_title()} - BudgetPilot</title>
</svelte:head>

<main class="flex min-h-screen items-center justify-center bg-zinc-50 px-4 py-10 text-zinc-950">
	<section class="w-full max-w-lg">
		<div class="{cardBase} p-8">
			<span class="text-2xl font-semibold tracking-tight text-zinc-950">BudgetPilot</span>

			<h1 class="mt-8 text-xl font-semibold tracking-normal">{m.origin_mismatch_title()}</h1>
			<AlertBanner variant="warning" class="mt-4">{m.origin_mismatch_lede()}</AlertBanner>

			<dl class="mt-6 grid gap-4">
				<div class="grid gap-1">
					<dt class="text-xs font-medium text-zinc-500">{m.origin_mismatch_arrived_label()}</dt>
					<dd class={valueBlock}>{arrived}</dd>
				</div>
				<div class="grid gap-1">
					<dt class="text-xs font-medium text-zinc-500">{m.origin_mismatch_expected_label()}</dt>
					<dd class={valueBlock}>{data.expected}</dd>
				</div>
			</dl>

			<h2 class="mt-8 text-sm font-semibold">{m.origin_mismatch_remedy_heading()}</h2>
			<p class="mt-2 {valueBlock}">ORIGIN={arrived}</p>
			<p class="mt-2 text-sm text-zinc-500">{m.origin_mismatch_remedy_note()}</p>

			<div class="mt-6 flex justify-end">
				<Button onclick={() => window.location.reload()}>{m.origin_mismatch_back()}</Button>
			</div>
		</div>
	</section>
</main>
