<script lang="ts">
	import type { Snippet } from 'svelte';
	import { transitionHover } from '$lib/styles';

	// Shared icon-only button. The icon itself is always supplied by the
	// caller (Snippet) — this component only owns the container/behavior/style,
	// never a fixed icon set.
	//
	// `shape` covers the distinct visual conventions already established
	// across the app before this component existed, kept unchanged on
	// purpose (migrating implementation, not redesigning look):
	// - 'circle' (default): plain ghost icon button (edit/delete/close/...).
	// - 'box': bordered rounded-md box used by the "r" regex-mode toggles
	//   (rules, transactions desktop) — border-zinc-300/zinc-900 look.
	// - 'pill': bordered rounded-full box used by the ".*" regex-mode toggle
	//   (transactions mobile) — border-zinc-200/zinc-900 look.
	let {
		tone = 'neutral',
		shape = 'circle',
		label,
		pressed,
		type = 'button',
		onclick,
		disabled = false,
		class: extraClass = '',
		title,
		children
	}: {
		tone?: 'neutral' | 'danger';
		shape?: 'circle' | 'box' | 'pill';
		label: string;
		pressed?: boolean;
		type?: 'button' | 'submit';
		onclick?: () => void;
		disabled?: boolean;
		class?: string;
		title?: string;
		children: Snippet;
	} = $props();

	// 44x44 minimum touch target everywhere (not just mobile) — see project
	// a11y conventions. Several pre-existing sites this component replaces
	// were under that size; migrating to IconButton brings them up to it.
	const base = `inline-flex min-h-11 min-w-11 items-center justify-center ${transitionHover} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40`;

	const shapeToneClasses = $derived.by(() => {
		if (shape === 'box') {
			// Mirrors the pre-existing "r" regex-toggle box exactly.
			return pressed
				? 'rounded-md border border-zinc-900 bg-zinc-900 font-mono text-xs font-semibold text-white'
				: 'rounded-md border border-zinc-300 bg-white font-mono text-xs font-semibold text-zinc-500 hover:bg-zinc-50';
		}
		if (shape === 'pill') {
			// Mirrors the pre-existing ".*" regex-toggle pill exactly.
			return pressed
				? 'rounded-full border border-zinc-900 bg-zinc-900 px-2.5 font-mono text-[11px] font-semibold text-white'
				: 'rounded-full border border-zinc-200 bg-white px-2.5 font-mono text-[11px] font-semibold text-zinc-500';
		}
		// shape === 'circle'
		if (pressed) {
			return 'rounded-full bg-zinc-900 text-white hover:bg-zinc-800';
		}
		if (tone === 'danger') {
			return 'rounded-full text-rose-600 hover:bg-rose-50 hover:text-rose-700';
		}
		return 'rounded-full text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700';
	});

	const ringClasses = $derived(
		tone === 'danger' ? 'focus-visible:ring-rose-500' : 'focus-visible:ring-zinc-400'
	);
</script>

<button
	{type}
	{disabled}
	aria-label={label}
	aria-pressed={pressed}
	{title}
	{onclick}
	class="{base} {shapeToneClasses} {ringClasses} {extraClass}"
>
	{@render children()}
</button>
