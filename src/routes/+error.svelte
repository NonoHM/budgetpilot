<script lang="ts">
	import { page } from '$app/state';
	import Button from '$lib/components/Button.svelte';
	import { cardBase } from '$lib/styles';
	import * as m from '$lib/paraglide/messages';

	const isNotFound = $derived(page.status === 404);
	const title = $derived(isNotFound ? m.error_not_found_title() : m.error_generic_title());
	const description = $derived(
		isNotFound ? m.error_not_found_description() : m.error_generic_description()
	);
</script>

<svelte:head>
	<title>{title} - BudgetPilot</title>
</svelte:head>

<main class="flex min-h-screen items-center justify-center bg-zinc-50 px-4 py-10 text-zinc-950">
	<section class="w-full max-w-md text-center">
		<div class="{cardBase} p-8">
			<span class="text-2xl font-semibold tracking-tight text-zinc-950">BudgetPilot</span>

			<h1 class="mt-8 text-xl font-semibold tracking-normal">{title}</h1>
			<p class="mt-2 text-sm text-zinc-500">{description}</p>

			<div class="mt-6 flex justify-center gap-3">
				{#if !isNotFound}
					<Button variant="secondary" onclick={() => window.location.reload()}>
						{m.error_retry()}
					</Button>
				{/if}
				<Button href="/">
					{m.error_back_to_dashboard()}
				</Button>
			</div>
		</div>
	</section>
</main>
