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
		softDisabled = false,
		'aria-describedby': ariaDescribedby,
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
		/**
		 * Neutralised but still reachable — `aria-disabled`, never the native `disabled`. Design 1q
		 * makes this law for EVERY neutralised control in the app, not only primary actions: a
		 * control that is switched off must still be focusable so it can state its own reason, and
		 * that reason is carried by `aria-describedby`. A natively `disabled` button is unreachable
		 * by keyboard and therefore mute, which is the shape CLAUDE.md already records four sightings
		 * of. Mirrors `Button.svelte`'s prop of the same name, including swallowing the click.
		 *
		 * The corollary, from 1q: a control whose neutralisation cannot be explained is not
		 * neutralised — it is removed, or it does not exist yet. So `softDisabled` without an
		 * `aria-describedby` is a half-applied rule.
		 */
		softDisabled?: boolean;
		'aria-describedby'?: string;
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
	aria-disabled={softDisabled ? 'true' : undefined}
	aria-describedby={ariaDescribedby}
	{title}
	onclick={(event) => {
		if (softDisabled) {
			// Swallowed here rather than left to the caller, and `stopImmediatePropagation` because a
			// `type="submit"` inside a form would otherwise still submit: this is a real, focusable,
			// tabbable button, and only the activation is switched off.
			event.preventDefault();
			event.stopImmediatePropagation();
			return;
		}
		onclick?.();
	}}
	class="{base} {shapeToneClasses} {ringClasses} {softDisabled
		? 'cursor-default text-zinc-400'
		: ''} {extraClass}"
>
	{@render children()}
</button>
