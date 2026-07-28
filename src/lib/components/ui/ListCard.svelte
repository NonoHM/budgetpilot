<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as m from '$lib/paraglide/messages';
	import { cardBase, transitionHover } from '$lib/styles';

	// Generic mobile replacement for a table row (< lg). Primary content is
	// always visible (the columns you'd scan in a table); details is revealed
	// on demand, either via an expand toggle or by navigating to `href`.
	let {
		active = false,
		href,
		linkId,
		expandLabel,
		expandAriaLabel,
		children,
		details
	}: {
		active?: boolean;
		href?: string;
		// DOM id forwarded to the <a> so a caller can programmatically refocus the
		// row (e.g. transactions' mobile sheet restores focus to its opener row,
		// since navigation-driven opens lose the pre-open focus to <body>).
		linkId?: string;
		// Visible text on the toggle button, replacing the default "···"/"−" glyph.
		expandLabel?: string;
		// aria-label only, independent of expandLabel — use this instead of/alongside
		// expandLabel when a list has several rows and the visible glyph should stay a
		// short, neutral affordance while each row's accessible name still needs to be
		// unique (e.g. "Delete rule {name}" per row).
		expandAriaLabel?: string;
		children: Snippet;
		details?: Snippet;
	} = $props();

	let expanded = $state(false);
</script>

<!-- Focus rings are inset: the overflow-hidden wrapper (needed so hover/press
     backgrounds respect the card radius) would clip a default outline or an
     offset ring drawn outside the focused element. -->
<div
	class="overflow-hidden {cardBase} {active ? 'bg-zinc-50 ring-1 ring-zinc-900/10 ring-inset' : ''}"
>
	{#if href}
		<!-- generic reusable component: `href` is an arbitrary caller-supplied string (internal route
		or external URL), not statically known here; the caller is responsible for resolving it -->
		<!-- eslint-disable svelte/no-navigation-without-resolve -->
		<a
			{href}
			id={linkId}
			class="block p-4 hover:bg-zinc-50 active:bg-zinc-100 {transitionHover} focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none focus-visible:ring-inset"
		>
			{@render children()}
		</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	{:else}
		<div class="p-4">
			{@render children()}
		</div>
	{/if}

	{#if details}
		<button
			type="button"
			class="flex min-h-[44px] w-full items-center justify-center border-t border-zinc-100 text-xs font-medium text-zinc-500 hover:bg-zinc-50 {transitionHover} focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none focus-visible:ring-inset"
			onclick={() => (expanded = !expanded)}
			aria-expanded={expanded}
			aria-label={expandAriaLabel ??
				expandLabel ??
				(expanded ? m.common_hide_details() : m.common_show_details())}
		>
			{expandLabel ?? (expanded ? '−' : '···')}
		</button>
		{#if expanded}
			<div class="border-t border-zinc-100 p-4">
				{@render details()}
			</div>
		{/if}
	{/if}
</div>
