<script lang="ts">
	import type { Snippet } from 'svelte';
	import Spinner from './ui/Spinner.svelte';
	import * as m from '$lib/paraglide/messages';
	import { transitionHover } from '$lib/styles';

	let {
		variant = 'primary',
		type = 'button',
		size = 'md',
		href,
		disabled = false,
		loading = false,
		loadingLabel,
		class: extraClass = '',
		children,
		...rest
	}: {
		variant?: 'primary' | 'positive' | 'danger' | 'secondary' | 'ghost' | 'ghost-danger';
		type?: 'button' | 'submit' | 'reset';
		// 'field' is the exact 44px (h-11) match for Select/Combobox/MoneyInput/
		// SearchBar/inputBase — use it whenever a Button sits in the same row as
		// one of those (filter bars, inline forms), never a one-off h-11 class.
		size?: 'sm' | 'md' | 'lg' | 'field';
		// Renders an <a> with the exact same appearance — link semantics for real
		// navigation (pagination, CTA to another page). `type`/`loading` don't
		// apply to the anchor variant; a disabled anchor drops its href and is
		// removed from the tab order (aria-disabled announced instead).
		href?: string;
		disabled?: boolean;
		// Replaces the button's text with an inline spinner while a submission
		// is in flight (button never shows an unlabeled icon: `loadingLabel`
		// falls back to a generic sr-only announcement). Caller owns the
		// `submitting` state (wired to use:enhance's submit/settle lifecycle).
		loading?: boolean;
		loadingLabel?: string;
		class?: string;
		children: Snippet;
		[key: string]: unknown;
	} = $props();

	const base = `rounded-xl font-semibold ${transitionHover} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40`;

	const sizes: Record<string, string> = {
		sm: 'px-3 py-1.5 text-sm',
		md: 'px-4 py-2 text-sm',
		lg: 'px-5 py-2.5 text-sm',
		field: 'h-11 px-4 text-sm'
	};

	const variants: Record<string, string> = {
		primary: 'bg-zinc-950 text-white hover:bg-zinc-800 focus-visible:ring-zinc-900',
		positive: 'bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-emerald-500',
		danger: 'bg-rose-600 text-white hover:bg-rose-700 focus-visible:ring-rose-500',
		secondary:
			'border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 focus-visible:ring-zinc-900',
		ghost: 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 focus-visible:ring-zinc-900',
		'ghost-danger': 'text-rose-600 hover:bg-rose-50 hover:text-rose-700 focus-visible:ring-rose-500'
	};
</script>

{#if href !== undefined}
	<!-- generic reusable component: `href` is an arbitrary caller-supplied string (internal route
	or external URL), not statically known here; the caller is responsible for resolving it -->
	<!-- eslint-disable svelte/no-navigation-without-resolve -->
	<a
		href={disabled ? undefined : href}
		aria-disabled={disabled ? 'true' : undefined}
		tabindex={disabled ? -1 : undefined}
		class="inline-flex items-center justify-center {base} {sizes[size]} {variants[
			variant
		]} {disabled ? 'pointer-events-none opacity-40' : ''} {extraClass}"
		{...rest}
	>
		{@render children()}
	</a>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
{:else}
	<button
		{type}
		disabled={disabled || loading}
		aria-busy={loading}
		class="{base} {sizes[size]} {variants[variant]} {extraClass}"
		{...rest}
	>
		{#if loading}
			<span class="inline-flex items-center justify-center gap-2">
				<Spinner size={14} speedMs={800} />
				<span class="sr-only">{loadingLabel ?? m.common_loading()}</span>
			</span>
		{:else}
			{@render children()}
		{/if}
	</button>
{/if}
