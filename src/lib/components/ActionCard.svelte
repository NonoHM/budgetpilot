<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cardBase } from '$lib/styles';

	let {
		title,
		description,
		tone = 'default',
		children
	}: {
		title: string;
		description: string;
		tone?: 'default' | 'danger';
		children: Snippet;
	} = $props();

	const cardClasses = $derived(
		tone === 'danger'
			? 'rounded-3xl border border-rose-200 bg-white p-4 lg:rounded-lg'
			: `${cardBase} !bg-zinc-50 p-4`
	);
	const titleClasses = $derived(
		tone === 'danger' ? 'font-medium text-rose-950' : 'font-medium text-zinc-950'
	);
	const descriptionClasses = $derived(
		tone === 'danger' ? 'mt-1 text-sm text-rose-800' : 'mt-1 text-sm text-zinc-600'
	);
</script>

<div class={cardClasses}>
	<h3 class={titleClasses}>{title}</h3>
	<p class={descriptionClasses}>{description}</p>
	<div class="mt-4">
		{@render children()}
	</div>
</div>
