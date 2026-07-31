<script lang="ts">
	import type { Snippet } from 'svelte';
	import Button from '$lib/components/Button.svelte';
	import TapLink from './TapLink.svelte';
	import { cardBase } from '$lib/styles';

	// Shared empty-state layout: solid card (never a dashed border), 44x44
	// round icon (content supplied by the caller, same Snippet convention as
	// IconButton), bold title + centered description, optional primary CTA.
	//
	// The primary CTA accepts either a free-form `action` snippet (for call
	// sites whose action area doesn't fit a single button — e.g. /reports'
	// import + "change period" pair) or the simpler `ctaLabel` +
	// `onCtaClick`/`ctaHref` props (rendered as a Button or a Button-styled
	// anchor). `action` takes priority when both are supplied.
	//
	// `detail` renders an optional block between the description and the
	// action/CTA — e.g. an "observation counter" listing merchants a
	// recurrence detector has seen but not yet confirmed. Documented slot
	// (not a one-off) so other call sites can reuse it the same way.
	//
	// `secondaryLabel`/`onSecondaryClick` render a TapLink below the primary
	// CTA — scoped to the dashboard's double CTA (import + manual entry) per
	// CLAUDE.md; other call sites should use a single CTA or a custom
	// `action` snippet instead of reaching for this prop.
	//
	// `card` defaults to true (wraps in `cardBase`, the full-page empty-state
	// look). Pass `card={false}` for a lighter-weight empty state nested
	// inside a panel that's already carded (e.g. /rules, /categories lists),
	// where a second nested border/shadow would look wrong.
	let {
		icon,
		iconBgClass = 'bg-zinc-100',
		title,
		description,
		detail,
		action,
		ctaLabel,
		ctaHref,
		onCtaClick,
		secondaryLabel,
		onSecondaryClick,
		card = true,
		class: extraClass = ''
	}: {
		icon?: Snippet;
		iconBgClass?: string;
		title?: string;
		description?: string;
		// Optional data block under the description — e.g. observation counters. Documented slot, referential brick 7.
		detail?: Snippet;
		action?: Snippet;
		ctaLabel?: string;
		ctaHref?: string;
		onCtaClick?: () => void;
		secondaryLabel?: string;
		onSecondaryClick?: () => void;
		card?: boolean;
		class?: string;
	} = $props();

	const anchorCtaClasses =
		'inline-flex w-full items-center justify-center rounded-xl bg-zinc-950 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2 sm:w-auto';
</script>

<div
	class="flex flex-col items-center gap-2.5 text-center {card
		? `${cardBase} px-6 py-16`
		: 'py-12'} {extraClass}"
>
	{#if icon}
		<div class="flex h-11 w-11 items-center justify-center rounded-full {iconBgClass}">
			{@render icon()}
		</div>
	{/if}
	{#if title}
		<h2 class="mt-1 text-[14.5px] font-bold text-zinc-900">{title}</h2>
	{/if}
	{#if description}
		<p class="max-w-xs text-[13px] leading-relaxed text-zinc-500">{description}</p>
	{/if}
	{#if detail}
		<div class="mt-1 w-full max-w-xs">
			{@render detail()}
		</div>
	{/if}
	{#if action}
		{@render action()}
	{:else if ctaLabel}
		<div class="mt-3 w-full sm:w-auto">
			{#if ctaHref}
				<!-- generic reusable component: `ctaHref` is an arbitrary caller-supplied string
				(internal route or external URL), not statically known here; the caller is
				responsible for resolving it -->
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a href={ctaHref} class={anchorCtaClasses}>{ctaLabel}</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{:else}
				<Button size="lg" class="w-full sm:w-auto" onclick={onCtaClick}>{ctaLabel}</Button>
			{/if}
		</div>
	{/if}
	{#if secondaryLabel && onSecondaryClick}
		<TapLink onclick={onSecondaryClick}>{secondaryLabel}</TapLink>
	{/if}
</div>
