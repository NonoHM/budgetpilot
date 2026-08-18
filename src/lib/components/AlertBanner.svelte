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
		focusOnShow = false,
		onDismiss,
		dismissLabel,
		action,
		children
	}: {
		// `info` is the neutral one, and its tone is a decision rather than a leftover default: it
		// carries no judgement, so it gets no judgement colour. Rose says the user broke something
		// and amber says something is wrong, and both are false for a banner that merely offers a
		// choice. Zinc is what the design plate already uses for the staged split removal, for
		// exactly that reason. Never auto-dismissed: an offer the reader has not answered yet is
		// not a confirmation that can expire.
		variant: 'success' | 'error' | 'warning' | 'info';
		size?: 'sm' | 'md';
		class?: string;
		// Only applied to variant="success" — errors/warnings stay until the user dismisses
		// them manually, since reading/acting on those shouldn't be time-constrained. Pass
		// Infinity (not a large finite number) to disable auto-dismiss for a success banner
		// that must persist until manually dismissed — setTimeout clamps/fires near-immediately
		// past ~24.8 days (the 32-bit signed int delay limit), so a large-but-finite value would
		// silently misbehave instead of meaning "never".
		autoDismissMs?: number;
		/**
		 * Takes the focus when it appears, and only then.
		 *
		 * For a banner that arrives where the focus IS NOT: a failure inside a dialog appears above a
		 * confirm button the user is already on, and `role="alert"` announces it without moving anyone
		 * to it. The two are different mechanisms and they fail separately, so the announcement alone
		 * leaves a keyboard or screen-reader user reading a message they cannot reach the actions of
		 * without hunting.
		 *
		 * Off by default: a page-level banner reporting what just happened must NOT steal the focus,
		 * which is the whole reason brique 8 specifies `role="status"` for the polite variants.
		 */
		focusOnShow?: boolean;
		// Optional side effect fired when the banner is dismissed (manually or via
		// auto-dismiss) — e.g. persisting the dismissal server-side so it doesn't
		// reappear on the next load. Purely additive: existing callers that don't pass
		// it keep the same local-only dismiss behavior.
		onDismiss?: () => void;
		// Accessible name for the close control, when "Close" would understate what it does.
		// Defaults to it, which is honest for a banner that merely goes away. It is NOT honest for
		// one whose dismissal is persisted: there the X is a permanent decision, and a control
		// announced as "Close" gives a screen reader user no way to know that before pressing it.
		// Pass what the choice means, e.g. "Keep the current category names".
		dismissLabel?: string;
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
		warning: 'border-amber-200 bg-amber-50 text-amber-900',
		info: 'border-zinc-300 bg-zinc-100 text-zinc-700'
	} as const;

	const iconWrapClasses = {
		success: 'bg-emerald-100/60 text-emerald-700',
		error: 'bg-rose-100/60 text-rose-700',
		warning: 'bg-amber-100/60 text-amber-700',
		info: 'bg-zinc-200/70 text-zinc-700'
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

	// `info` is polite for the same reason `success` is: it reports rather than interrupts. An
	// assertive region cuts across whatever the reader is in the middle of, which is right for an
	// error blocking their action and wrong for an offer they can take at any time.
	let bannerEl = $state<HTMLElement | null>(null);

	/**
	 * Focused once it is on screen, and AFTER the effect flush rather than inside it.
	 *
	 * `queueMicrotask` is not a delay, it is an ordering. A child's effects run before its parent's,
	 * so a banner focusing itself inside a modal loses to that modal's own open-focus, which runs
	 * afterwards and puts the reader back on the close control. Measured: the focus landed on
	 * « Fermer ». The microtask runs after the whole flush, so the last write is this one.
	 */
	$effect(() => {
		if (!focusOnShow) return;
		const el = bannerEl;
		queueMicrotask(() => el?.focus());
	});

	const politeVariants = ['success', 'info'];
	const role = $derived(politeVariants.includes(variant) ? 'status' : 'alert');
	const ariaLive = $derived(politeVariants.includes(variant) ? 'polite' : 'assertive');
</script>

{#if !dismissed}
	<!--
		svelte-ignore a11y_no_noninteractive_tabindex
		The rule reads « nonnegative tabIndex », and this one is -1, which is exactly the value that
		makes an element a programmatic focus target WITHOUT adding it to the tab order. The analyser
		cannot narrow the ternary, so it sees `number | undefined` and assumes the worst. Suppressed
		with the reason rather than by weakening the attribute, which would be the actual defect.
	-->
	<p
		bind:this={bannerEl}
		class="flex items-start gap-2.5 border font-medium {variantClasses[variant]} {sizeClasses[
			size
		]} {className} focus-visible:outline-none"
		{role}
		aria-live={ariaLive}
		tabindex={focusOnShow ? -1 : undefined}
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
			{:else if variant === 'warning'}
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
			{:else}
				<!-- `info` gets its own glyph, and the differences from `error` are deliberate rather
				     than incidental, because zinc against rose is a colour difference and colour is
				     never allowed to carry a distinction on its own. This circle is STROKED where
				     error's is filled, and its dot sits ABOVE the bar where error's sits below. Two
				     shape differences, legible at the 12px this renders at, before any colour is
				     read. -->
				<svg
					viewBox="0 0 20 20"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					stroke-linecap="round"
					class={svgSizeClasses[size]}
				>
					<circle cx="10" cy="10" r="8" />
					<circle cx="10" cy="6.2" r="0.9" fill="currentColor" stroke="none" />
					<line x1="10" y1="9.4" x2="10" y2="14.5" />
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
			label={dismissLabel ?? m.common_close()}
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
