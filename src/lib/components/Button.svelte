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
		softDisabled = false,
		loading = false,
		loadingLabel,
		class: extraClass = '',
		onclick,
		children,
		...rest
	}: {
		variant?: 'primary' | 'positive' | 'danger' | 'secondary' | 'ghost' | 'ghost-danger';
		type?: 'button' | 'submit' | 'reset';
		// Two sizes exist only to agree with a height something ELSE renders, and
		// which one is right depends on what the button sits beside:
		//
		// 'field' — 44px (h-11), the primary-form-field template: Select,
		//   Combobox, MoneyInput, SearchBar's default density, inputBase. Use it
		//   for a button in an inline form, beside a real data-entry field.
		//
		// 'bar'  — 34px, the filter-bar control template: FilterDropdown's and
		//   PeriodFilter's trigger groups. A filter bar is chrome, not a form to
		//   fill in, and its controls carry their own smaller height; a 44px
		//   button beside three 34px triggers reads as a defect before it reads
		//   as hierarchy. Desktop only — the mobile filter rows keep 44px,
		//   which is the design's touch floor and is not what this is about.
		//
		// Both are measured in Button.svelte.spec.ts rather than asserted from
		// class names, because a class list cannot show two components disagreeing
		// about a number.
		size?: 'sm' | 'md' | 'lg' | 'field' | 'bar';
		// Renders an <a> with the exact same appearance — link semantics for real
		// navigation (pagination, CTA to another page). `type`/`loading` don't
		// apply to the anchor variant; a disabled anchor drops its href and is
		// removed from the tab order (aria-disabled announced instead).
		href?: string;
		disabled?: boolean;
		// Inert but still focusable: renders aria-disabled instead of the native
		// attribute and swallows activation. Opt-in, so no existing caller
		// changes behaviour.
		//
		// Use it whenever the reason a control is inactive is something the user
		// has to READ to act on. A natively disabled button leaves the tab order
		// and announces nothing, so a keyboard or screen-reader user meets a
		// control they cannot reach and an explanation they never hear. Pair it
		// with aria-describedby pointing at that explanation, rendered visibly
		// once — `...rest` forwards the attribute.
		//
		// Keep native `disabled` for the ordinary case where inactivity is
		// self-evident from the form's own state.
		softDisabled?: boolean;
		// Replaces the button's text with an inline spinner while a submission
		// is in flight (button never shows an unlabeled icon: `loadingLabel`
		// falls back to a generic sr-only announcement). Caller owns the
		// `submitting` state (wired to use:enhance's submit/settle lifecycle).
		loading?: boolean;
		loadingLabel?: string;
		class?: string;
		onclick?: (event: MouseEvent) => void;
		children: Snippet;
		[key: string]: unknown;
	} = $props();

	const base = `rounded-xl font-semibold ${transitionHover} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40`;

	const sizes: Record<string, string> = {
		sm: 'px-3 py-1.5 text-sm',
		md: 'px-4 py-2 text-sm',
		lg: 'px-5 py-2.5 text-sm',
		field: 'h-11 px-4 text-sm',
		bar: 'h-[34px] px-3.5 text-sm'
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
		aria-disabled={softDisabled ? 'true' : undefined}
		aria-busy={loading}
		class="{base} {sizes[size]} {variants[variant]} {softDisabled
			? 'cursor-default text-zinc-500'
			: ''} {extraClass}"
		{...rest}
		onclick={(event) => {
			// Composed rather than spread through `...rest`, and declared AFTER it, so a caller's own
			// handler can never overwrite the swallow. A soft-disabled button is a real button: without
			// this, a submit would still submit and a click handler would still fire.
			if (softDisabled) {
				event.preventDefault();
				event.stopImmediatePropagation();
				return;
			}
			onclick?.(event);
		}}
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
