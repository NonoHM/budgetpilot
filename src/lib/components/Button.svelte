<script lang="ts">
	import type { Snippet } from 'svelte';
	import Spinner from './ui/Spinner.svelte';
	import * as m from '$lib/paraglide/messages';
	import { pressable } from '$lib/press';
	import {
		pressDanger,
		pressFilled,
		pressFilledRose,
		pressInset,
		pressNeutral,
		pressTransition,
		transitionHover
	} from '$lib/styles';

	let {
		variant = 'primary',
		type = 'button',
		size = 'md',
		href,
		disabled = false,
		softDisabled = false,
		loading = false,
		loadingLabel,
		busyLabel,
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
		/**
		 * THE OCCUPANCY CONTRACT, registered by Planche 5f as a clause of brique 9 rather than as a
		 * component. Opt-in, so `loading` alone keeps every existing caller's behaviour.
		 *
		 * Three things differ from `loading` alone, and each is a rule rather than a preference:
		 *
		 * The verb is VISIBLE. « Suppression… » is the same action in its course; a bare spinner with
		 * a generic sr-only fallback says nothing about what is running, and the measured state of
		 * this button showed « En cours… ».
		 *
		 * `aria-busy` REPLACES the native `disabled`. A disabled button leaves the tab order and
		 * announces nothing, which sends focus to the body at the exact moment the user is waiting for
		 * an answer at the place they pressed. It stays focusable, keeps its name, and swallows the
		 * activation instead, which is the same rule `softDisabled` already applies.
		 *
		 * The WIDTH IS FROZEN at the resting measurement, so a footer does not reorganise under the
		 * finger while the label changes length.
		 */
		busyLabel?: string;
		class?: string;
		onclick?: (event: MouseEvent) => void;
		children: Snippet;
		[key: string]: unknown;
	} = $props();

	// `pressTransition` after `transitionHover`, so the pressed variant wins: entry with no
	// transition, exit keeping the 120 ms ease-out. Planche 5a. The floor and the cancel path are in
	// `$lib/press.ts`.
	const base = `rounded-xl font-semibold ${transitionHover} ${pressTransition} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40`;

	/** True only for the occupancy contract above, never for the plain `loading` spinner. */
	const busy = $derived(loading && busyLabel !== undefined);
	/**
	 * Measured while resting, applied while busy. `undefined` until the first measurement.
	 *
	 * Read from `getBoundingClientRect()` and NOT from `clientWidth`, which is integer-rounded: the
	 * first version froze 98 against a resting 97.86, so the footer still moved by a fraction of a
	 * pixel. Caught by asserting the two states against each other rather than against a figure.
	 */
	let restingWidth = $state<number | undefined>(undefined);
	let buttonEl = $state<HTMLButtonElement | null>(null);

	$effect(() => {
		if (busy || !buttonEl) return;
		const width = buttonEl.getBoundingClientRect().width;
		if (width > 0) restingWidth = width;
	});

	const sizes: Record<string, string> = {
		sm: 'px-3 py-1.5 text-sm',
		md: 'px-4 py-2 text-sm',
		lg: 'px-5 py-2.5 text-sm',
		field: 'h-11 px-4 text-sm',
		bar: 'h-[34px] px-3.5 text-sm'
	};

	/**
	 * The pressed pair per variant, Planche 5a.
	 *
	 * The two fills sink rather than lighten, because a fill cannot lighten without changing tone.
	 * The bordered and text variants take brique 1's hover pair, moved onto the press.
	 *
	 * `positive` IS THE ONE VARIANT WITH NO REGISTERED PAIR: the plate names eight tones and emerald
	 * is not among them. It sinks and keeps its hue rather than being handed an emerald-800 nobody
	 * has measured for contrast. Registered as a gap rather than filled in silence, see
	 * `docs/reference/design-referential.md`.
	 */
	const pressVariants: Record<string, string> = {
		primary: pressFilled,
		positive: pressInset,
		danger: pressFilledRose,
		secondary: pressNeutral,
		ghost: pressNeutral,
		'ghost-danger': pressDanger
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
		use:pressable
		href={disabled ? undefined : href}
		aria-disabled={disabled ? 'true' : undefined}
		tabindex={disabled ? -1 : undefined}
		class="inline-flex items-center justify-center {base} {sizes[size]} {variants[
			variant
		]} {pressVariants[variant]} {disabled ? 'pointer-events-none opacity-40' : ''} {extraClass}"
		{...rest}
	>
		{@render children()}
	</a>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
{:else}
	<button
		use:pressable
		bind:this={buttonEl}
		{type}
		disabled={busy ? false : disabled || loading}
		aria-disabled={softDisabled ? 'true' : undefined}
		aria-busy={loading}
		style:width={busy && restingWidth !== undefined ? `${restingWidth}px` : undefined}
		class="{base} {sizes[size]} {variants[variant]} {pressVariants[variant]} {softDisabled
			? 'cursor-default text-zinc-500'
			: ''} {extraClass}"
		{...rest}
		onclick={(event) => {
			// Composed rather than spread through `...rest`, and declared AFTER it, so a caller's own
			// handler can never overwrite the swallow. A soft-disabled button is a real button: without
			// this, a submit would still submit and a click handler would still fire.
			if (softDisabled || busy) {
				event.preventDefault();
				event.stopImmediatePropagation();
				return;
			}
			onclick?.(event);
		}}
	>
		{#if busy}
			<span class="inline-flex items-center justify-center gap-2">
				<Spinner size={16} speedMs={800} />
				{busyLabel}
			</span>
		{:else if loading}
			<span class="inline-flex items-center justify-center gap-2">
				<Spinner size={14} speedMs={800} />
				<span class="sr-only">{loadingLabel ?? m.common_loading()}</span>
			</span>
		{:else}
			{@render children()}
		{/if}
	</button>
{/if}
