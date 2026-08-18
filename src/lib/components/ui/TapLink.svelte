<script lang="ts">
	import type { Snippet } from 'svelte';
	import { pressable } from '$lib/press';
	import {
		pressTransition,
		pressUnderline,
		pressUnderlineDanger,
		transitionHover
	} from '$lib/styles';

	// Shared replacement for a permanently-underlined text link (component
	// referential, brick 4): plain text, no chevron, no background/border, no
	// permanent underline. Affordance comes from color + font-weight (600) and
	// from sitting in an already-interactive context (list row, card, under an
	// action title) — the underline itself only appears on desktop mouse hover
	// (`lg:hover:underline`), never on mobile (no hover on touch).
	//
	// Renders an <a> when `href` is given (real navigation), or a <button>
	// when `onclick` is given (in-place expansion / action) — `type` lets the
	// button variant act as a real form submit control (e.g. a POST logout
	// link) instead of a plain JS handler.
	//
	// Not for links embedded inline in a sentence: this is a flex (block-level)
	// element and will break inline text flow.
	let {
		id,
		href,
		onclick,
		type = 'button',
		tone = 'default',
		disabled = false,
		class: extraClass = '',
		children
	}: {
		// Set only when something else has to reference this link (a focus target after a mutation,
		// an aria-labelledby); left off everywhere else.
		id?: string;
		href?: string;
		onclick?: () => void;
		type?: 'button' | 'submit';
		tone?: 'default' | 'danger';
		// Button variant: native `disabled` (same opacity-40 / cursor treatment as
		// IconButton). Anchor variant: href is dropped and aria-disabled set — a
		// disabled link must not navigate nor be tabbable, but should stay in the
		// accessibility tree with its name announced.
		disabled?: boolean;
		class?: string;
		children: Snippet;
	} = $props();

	const toneClasses = $derived(
		tone === 'danger'
			? 'text-rose-700 focus-visible:ring-rose-500'
			: 'text-zinc-700 focus-visible:ring-zinc-400'
	);

	/**
	 * The pressed state, Planche 5a, and it is a STROKE rather than a surface.
	 *
	 * Brique 4 forbids this brick a background and a border, so its press cannot be one. It is the
	 * underline the brick removed from the RESTING state, handed back at the press where it is
	 * transient. The danger tone darkens with it, to rose-800 #9f1239, because an underline alone is
	 * hard to see arriving under a finger on an already-rose word. 6.8:1 on white.
	 */
	const pressClasses = $derived(tone === 'danger' ? pressUnderlineDanger : pressUnderline);

	const classes = $derived(
		`inline-flex min-h-11 items-center text-sm font-semibold ${toneClasses} ${transitionHover} ${pressTransition} ${pressClasses} lg:hover:underline lg:hover:underline-offset-2 focus-visible:outline-none focus-visible:ring-2 rounded disabled:cursor-not-allowed disabled:opacity-40 ${
			disabled ? 'pointer-events-none opacity-40' : ''
		} ${extraClass}`
	);
</script>

{#if href !== undefined}
	<!-- generic reusable component: `href` is an arbitrary caller-supplied string (internal route
	or external URL), not statically known here; the caller is responsible for resolving it -->
	<!-- eslint-disable svelte/no-navigation-without-resolve -->
	<a
		use:pressable
		{id}
		href={disabled ? undefined : href}
		class={classes}
		aria-disabled={disabled ? 'true' : undefined}
		tabindex={disabled ? -1 : undefined}
	>
		{@render children()}
	</a>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
{:else}
	<button use:pressable {id} {type} class={classes} {onclick} {disabled}>
		{@render children()}
	</button>
{/if}
