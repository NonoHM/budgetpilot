<script lang="ts">
	import type { Snippet } from 'svelte';
	import { fly } from 'svelte/transition';
	import * as m from '$lib/paraglide/messages';
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import { MOTION, easeIn, easeOut, motionDuration } from '$lib/motion';

	let {
		variant,
		size = 'md',
		class: className = '',
		autoDismissMs = 6000,
		onDismiss,
		action,
		children
	}: {
		variant: 'success' | 'error' | 'warning';
		size?: 'sm' | 'md';
		class?: string;
		// Only applied to variant="success" — errors/warnings stay until the user dismisses
		// them manually, since reading/acting on those shouldn't be time-constrained. Pass
		// Infinity (not a large finite number) to disable auto-dismiss for a success banner
		// that must persist until manually dismissed — setTimeout clamps/fires near-immediately
		// past ~24.8 days (the 32-bit signed int delay limit), so a large-but-finite value would
		// silently misbehave instead of meaning "never".
		autoDismissMs?: number;
		// Optional side effect fired when the banner is dismissed (manually or via
		// auto-dismiss) — e.g. persisting the dismissal server-side so it doesn't
		// reappear on the next load. Purely additive: existing callers that don't pass
		// it keep the same local-only dismiss behavior.
		onDismiss?: () => void;
		// Optional single action, e.g. a bulk-apply "Annuler" undo (transverse-tags design, section
		// 6): rendered between the message and the close control, never after it and never
		// replacing it. At most one — this is a single Snippet slot, not a list, by construction.
		// The caller is expected to build it as a TapLink (ui/TapLink.svelte), styled to the
		// banner's own tone rather than TapLink's default zinc/rose text colour, with an
		// always-visible underline (`text-decoration:underline`) rather than TapLink's
		// hover-only one — an action inside a banner has no adjacent "this row is clickable"
		// context to lean on the way a list row does.
		action?: Snippet;
		children: Snippet;
	} = $props();

	let dismissed = $state(false);

	// Generalizes the setTimeout-based auto-hide already used for the focus-mode
	// "N transactions auto-classified" toast (src/routes/transactions/+page.svelte).
	$effect(() => {
		if (variant !== 'success' || !Number.isFinite(autoDismissMs)) return;
		const timer = setTimeout(() => {
			dismissed = true;
			onDismiss?.();
		}, autoDismissMs);
		return () => clearTimeout(timer);
	});

	const variantClasses = {
		success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
		error: 'border-rose-200 bg-rose-50 text-rose-700',
		warning: 'border-amber-200 bg-amber-50 text-amber-900'
	} as const;

	const iconWrapClasses = {
		success: 'bg-emerald-100/60 text-emerald-700',
		error: 'bg-rose-100/60 text-rose-700',
		warning: 'bg-amber-100/60 text-amber-700'
	} as const;

	const sizeClasses = {
		sm: 'rounded-md px-3 py-2 text-xs',
		md: 'rounded-xl px-4 py-3 text-sm'
	} as const;

	const iconSizeClasses = {
		sm: 'h-4 w-4',
		md: 'h-5 w-5'
	} as const;

	const svgSizeClasses = {
		sm: 'h-2.5 w-2.5',
		md: 'h-3 w-3'
	} as const;

	const role = $derived(variant === 'success' ? 'status' : 'alert');
	const ariaLive = $derived(variant === 'success' ? 'polite' : 'assertive');
</script>

{#if !dismissed}
	<p
		class="flex items-start gap-2.5 border font-medium {variantClasses[variant]} {sizeClasses[
			size
		]} {className}"
		{role}
		aria-live={ariaLive}
		in:fly={{ y: -4, duration: motionDuration(MOTION.overlayInMs), easing: easeOut }}
		out:fly={{ y: -4, duration: motionDuration(MOTION.overlayOutMs), easing: easeIn }}
	>
		<span
			class="mt-px flex shrink-0 items-center justify-center rounded-full {iconWrapClasses[
				variant
			]} {iconSizeClasses[size]}"
			aria-hidden="true"
		>
			{#if variant === 'success'}
				<svg
					viewBox="0 0 20 20"
					fill="none"
					stroke="currentColor"
					stroke-width="2.5"
					stroke-linecap="round"
					stroke-linejoin="round"
					class={svgSizeClasses[size]}
				>
					<path d="M4 10.5 8 14.5 16 6" />
				</svg>
			{:else if variant === 'error'}
				<svg viewBox="0 0 20 20" fill="currentColor" class={svgSizeClasses[size]}>
					<circle cx="10" cy="10" r="9" />
					<rect x="9" y="5" width="2" height="7" rx="1" fill="white" />
					<rect x="9" y="13.2" width="2" height="2" rx="1" fill="white" />
				</svg>
			{:else}
				<svg
					viewBox="0 0 20 20"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					stroke-linecap="round"
					stroke-linejoin="round"
					class={svgSizeClasses[size]}
				>
					<path d="M10 3 2 17h16Z" stroke-linejoin="round" />
					<line x1="10" y1="8.5" x2="10" y2="11.5" />
					<circle cx="10" cy="14.3" r="0.8" fill="currentColor" stroke="none" />
				</svg>
			{/if}
		</span>
		<span class="min-w-0 flex-1">{@render children()}</span>
		{#if action}
			{@render action()}
		{/if}
		<!-- -my-2.5 keeps the 44px close button from inflating the banner and
		     centers its glyph on the first text line (items-start container). -->
		<IconButton
			class="-my-2.5 -mr-1 shrink-0"
			label={m.common_close()}
			onclick={() => {
				dismissed = true;
				onDismiss?.();
			}}
		>
			<svg
				viewBox="0 0 20 20"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				class={svgSizeClasses[size]}
			>
				<path d="M5 5 15 15M15 5 5 15" />
			</svg>
		</IconButton>
	</p>
{/if}
