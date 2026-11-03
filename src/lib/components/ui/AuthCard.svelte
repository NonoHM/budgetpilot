<script lang="ts">
	import type { Snippet } from 'svelte';
	import BrandLink from './BrandLink.svelte';

	// Card shared by login / register / verify-totp / force-password-change:
	// same template at all screen sizes (no lg: split), the narrow centered
	// card is already appropriate everywhere.
	let { title, children }: { title?: Snippet; children: Snippet } = $props();
</script>

<main class="flex min-h-screen items-center justify-center bg-zinc-50 px-4 py-10 text-zinc-950">
	<div class="w-full max-w-md rounded-3xl border border-zinc-200 bg-white p-6 sm:p-8">
		<BrandLink />
		{#if title}
			<div class="mt-8">
				{@render title()}
			</div>
		{/if}
		<div class="mt-6">
			{@render children()}
		</div>
	</div>
</main>
