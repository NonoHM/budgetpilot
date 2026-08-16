<script lang="ts">
	import { chromeFor } from '$lib/domain/appChrome';
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
	 * How much chrome this route carries. The rule, its three states and the measured reason for
	 * each live in `$lib/domain/appChrome` — it has been wrong in both directions on
	 * `/import/columns` and deserved a name and a test rather than two arrays here.
	 */
	const chrome = $derived(chromeFor(page.url.pathname));
	const chromeless = $derived(chrome === 'none');
	const desktopChromeOnly = $derived(chrome === 'desktop');
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<div
	class="min-h-screen bg-zinc-50 text-zinc-950 {data.user && !chromeless && !desktopChromeOnly
		? 'pb-[calc(env(safe-area-inset-bottom)+8rem)] lg:pb-0'
		: ''} {data.user && desktopChromeOnly
		? 'lg:flex lg:h-screen lg:flex-col lg:overflow-hidden'
		: ''}"
>
	{#if data.user && desktopChromeOnly}
		<!--
			Desktop chrome only. The wrapper is what keeps `AppNav`'s fixed bottom bar out of the
			tree below `lg`: `display: none` on an ancestor removes a fixed descendant too, which a
			`lg:hidden` on the bar alone would not guarantee against a future change to it.
		-->
		<div class="hidden lg:block">
			<a
				href="#main-content"
				class="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-zinc-900 focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-white focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2"
			>
				{m.skip_to_main_content()}
			</a>
			<AppHeader {active} userEmail={data.user.email} isAdmin={data.user.role === 'ADMIN'} />
		</div>
	{/if}
	{#if data.user && !chromeless && !desktopChromeOnly}
		<a
			href="#main-content"
			class="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-zinc-900 focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-white focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2"
		>
			{m.skip_to_main_content()}
		</a>
		<AppHeader {active} userEmail={data.user.email} isAdmin={data.user.role === 'ADMIN'} />
	{/if}
	<!--
		`lg:min-h-0 lg:flex-1` on the desktop-chrome-only route, and the pair is load-bearing.

		The designation screen sizes its own frame with `h-full`, which resolves against this
		element. Under `min-h-screen` alone that is the WHOLE viewport, so adding an 87 px header
		pushed the frame 87 px past the fold and the page scrolled by exactly the header's height —
		the same overflow `/imports/<id>/columns` has always had. Making this a flex child of a
		`h-screen` column gives `h-full` the REMAINING space instead, with no measured constant to
		go stale. `min-h-0` is what lets it shrink: a flex item's automatic minimum is its content,
		and without it the frame pushes the column open again.
	-->
	<div
		id="main-content"
		tabindex="-1"
		class="outline-none {data.user && desktopChromeOnly ? 'lg:min-h-0 lg:flex-1' : ''}"
	>
		{@render children()}
	</div>
</div>
