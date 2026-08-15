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

	/**
	 * Routes that own the whole viewport: no header, no bottom tab bar, and none of the padding
	 * that reserves room for one.
	 *
	 * `/import/columns` is here because its design says so in as many words: a full page in the
	 * navigation stack, with the tab bar NOT shown, the way the transaction detail behaves. It is
	 * also here because of what happened when it was not. The screen builds its own 844 px stack,
	 * header plus body plus condition banner plus action footer, and the layout's `pb-32` plus a
	 * fixed `AppNav` painted the tab bar straight over the action footer: **the import control the
	 * whole screen exists to reach was half covered.**
	 *
	 * Nothing caught it. The component's four regions are asserted summing to 844 and every figure
	 * is true; the end-to-end journey passes, because Playwright clicks what a human cannot see. It
	 * was found by taking a screenshot for the manual. See the amendment in AGENTS.md under "the
	 * acceptance criterion for a screen is a journey completed".
	 *
	 * A route joins this list only when it renders its OWN full-height chrome. A page that merely
	 * looks busy does not qualify: removing the tab bar takes away the way out.
	 */
	const CHROMELESS_ROUTES = ['/force-password-change', '/import/columns'];
	const chromeless = $derived(CHROMELESS_ROUTES.includes(page.url.pathname));
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<div
	class="min-h-screen bg-zinc-50 text-zinc-950 {data.user && !chromeless
		? 'pb-[calc(env(safe-area-inset-bottom)+8rem)] lg:pb-0'
		: ''}"
>
	{#if data.user && !chromeless}
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
