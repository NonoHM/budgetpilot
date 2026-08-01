<script lang="ts">
	import { page } from '$app/state';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import * as m from '$lib/paraglide/messages';
	import type { LayoutData } from './$types';

	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();

	const active = $derived.by(() => {
		if (page.url.pathname.startsWith('/transactions')) return 'transactions';
		if (page.url.pathname.startsWith('/budgets')) return 'budgets';
		if (page.url.pathname.startsWith('/upcoming-bills')) return 'upcoming-bills';
		if (page.url.pathname.startsWith('/reports')) return 'reports';
		if (page.url.pathname.startsWith('/rules')) return 'rules';
		if (page.url.pathname.startsWith('/import')) return 'imports';
		if (page.url.pathname.startsWith('/net-worth')) return 'net-worth';
		if (page.url.pathname.startsWith('/settings')) return 'settings';
		return 'dashboard';
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<div
	class="min-h-screen bg-zinc-50 text-zinc-950 {data.user &&
	page.url.pathname !== '/force-password-change'
		? 'pb-[calc(env(safe-area-inset-bottom)+8rem)] lg:pb-0'
		: ''}"
>
	{#if data.user && page.url.pathname !== '/force-password-change'}
		<a
			href="#main-content"
			class="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-zinc-900 focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-white focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2"
		>
			{m.skip_to_main_content()}
		</a>
		<AppHeader {active} userEmail={data.user.email} isAdmin={data.user.role === 'ADMIN'} />
	{/if}
	<div id="main-content" tabindex="-1" class="outline-none">
		{@render children()}
	</div>
</div>
