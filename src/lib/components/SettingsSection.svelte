<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cardBase } from '$lib/styles';

	let {
		title,
		description,
		tone = 'default',
		header,
		children
	}: {
		title: string;
		description?: string;
		tone?: 'default' | 'danger';
		header?: Snippet;
		children: Snippet;
	} = $props();

	const sectionClasses = $derived(
		tone === 'danger'
			? 'rounded-3xl border border-rose-200 bg-rose-50 p-5 lg:rounded-lg'
			: `${cardBase} p-5`
	);

	const titleClasses = $derived(
		tone === 'danger' ? 'text-lg font-semibold text-rose-900' : 'text-lg font-semibold'
	);
	const descriptionClasses = $derived(
		tone === 'danger' ? 'mt-1 text-sm text-rose-800' : 'mt-1 text-sm text-zinc-600'
	);
	const dividerClasses = $derived(
		tone === 'danger' ? 'border-b border-rose-200 pb-4' : 'border-b border-zinc-200 pb-4'
	);
</script>

<section class={sectionClasses}>
	<div
		class={`flex flex-col gap-3 ${dividerClasses} sm:flex-row sm:items-start sm:justify-between`}
	>
		<div class="min-w-0">
			<h2 class={titleClasses}>{title}</h2>
			{#if description}
				<p class={descriptionClasses}>{description}</p>
			{/if}
		</div>
		{#if header}
			<div class="shrink-0">
				{@render header()}
			</div>
		{/if}
	</div>

	<div class="mt-4">
		{@render children()}
	</div>
</section>
