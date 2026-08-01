<script module lang="ts">
	// Module-level counter (not per-instance): guarantees stable, collision-free
	// ids across every Tooltip rendered on a page, without pulling in a UUID
	// dependency for something this small.
	let idCounter = 0;

	// Exported so the spec asserts the real boundary rather than a copy of it: a
	// hardcoded 400 in the test would keep passing if this value changed.
	export const HOVER_INTENT_DELAY_MS = 400;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { fade } from 'svelte/transition';
	import { MOTION, easeIn, easeOut, motionDuration } from '$lib/motion';

	// Generic hover/focus tooltip. Distinct from NetWorthChart's own tap/hover
	// value card (kept as-is on purpose, see architecture note) — this
	// component is for short static text labels attached to a single trigger
	// element (icon, truncated cell, chart segment, ...).
	let {
		label,
		wrapperClass = 'relative inline-flex',
		children
	}: { label: string; wrapperClass?: string; children: Snippet } = $props();

	let visible = $state(false);
	let openTimer: ReturnType<typeof setTimeout> | undefined;

	// Module-level counter deliberately persists across instances; the incremented value is
	// read by the NEXT Tooltip instance.
	// eslint-disable-next-line no-useless-assignment
	const tooltipId = `tooltip-${idCounter++}`;

	function scheduleOpen(): void {
		clearTimeout(openTimer);
		openTimer = setTimeout(() => {
			visible = true;
		}, HOVER_INTENT_DELAY_MS);
	}

	function close(): void {
		clearTimeout(openTimer);
		visible = false;
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') close();
	}
</script>

<span
	role="presentation"
	class={wrapperClass}
	onmouseenter={scheduleOpen}
	onmouseleave={close}
	onfocusin={() => {
		visible = true;
	}}
	onfocusout={close}
	onkeydown={handleKeydown}
>
	<!-- Mirrors the outer span's layout transparency: when wrapperClass makes the
		 outer span 'contents' (so the real child, not this wrapper, becomes the
		 flex/grid item — e.g. reports' percentage-width stacked bar segments), this
		 inner span must be 'contents' too, otherwise IT becomes the promoted item
		 instead and shrink-wraps its content, breaking the child's own width. -->
	<span aria-describedby={tooltipId} class={wrapperClass === 'contents' ? 'contents' : undefined}>
		{@render children()}
	</span>
	{#if visible}
		<span
			id={tooltipId}
			role="tooltip"
			class="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 -translate-x-1/2 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[12px] whitespace-nowrap text-white"
			in:fade={{ duration: motionDuration(MOTION.popoverInMs), easing: easeOut }}
			out:fade={{ duration: motionDuration(MOTION.popoverOutMs), easing: easeIn }}
		>
			{label}
		</span>
	{/if}
</span>
