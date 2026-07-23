<script lang="ts">
	import type { Snippet } from 'svelte';
	import { untrack } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { motionDuration } from '$lib/motion';
	import { createFocusRestore, focusFirst, trapTabKey } from '$lib/focus';

	// Mobile-only (<lg) counterpart to Modal.svelte: anchored to the bottom of the
	// screen instead of centered, with a drag handle for swipe-to-dismiss. Desktop
	// callers should keep using Modal — this component stays visually inert (display:none
	// via lg:hidden) at lg and above so it is safe to always mount.
	//
	// z-40 (below Modal's z-50) is deliberate, not incidental: a centered dialog
	// (e.g. delete confirmation) opened from inside this sheet must always paint
	// above it. Relying on DOM order to break the tie is fragile — a later reorder
	// of siblings in the host page would silently invert the stacking again.
	let {
		open = false,
		ariaLabel,
		onClose,
		children
	}: {
		open?: boolean;
		ariaLabel: string;
		onClose: () => void;
		children: Snippet;
	} = $props();

	let sheetEl = $state<HTMLElement | null>(null);
	const focusRestore = createFocusRestore();

	let dragging = $state(false);
	let dragY = $state(0);
	let startY = 0;

	// Entrance/exit timings. Deliberately BottomSheet's own values (not
	// MOTION.overlay*): the fly distance is large (y: 300), so it needs a
	// slightly longer run than Modal's fade+scale to read at the same speed.
	// motionDuration() still collapses both to 0 under prefers-reduced-motion —
	// only the drag *gesture* below stays outside the motion token rules.
	const SHEET_FADE_MS = 180;
	const SHEET_FLY_MS = 220;

	$effect(() => {
		const isOpen = open;
		untrack(() => {
			if (isOpen) {
				focusRestore.save();
				dragY = 0;
				focusFirst(sheetEl);
			} else {
				focusRestore.restore();
			}
		});
		return () => {
			focusRestore.restore();
		};
	});

	function handleWindowKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
		}
	}

	// Tab trap: cycle focus within the sheet (shared with Modal, see $lib/focus) —
	// required by aria-modal="true", which promises focus never escapes while open.
	function handleSheetKeydown(event: KeyboardEvent) {
		trapTabKey(event, sheetEl);
	}

	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget) onClose();
	}

	const DISMISS_THRESHOLD = 110;

	function handlePointerDown(event: PointerEvent) {
		dragging = true;
		startY = event.clientY;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function handlePointerMove(event: PointerEvent) {
		if (!dragging) return;
		const delta = event.clientY - startY;
		dragY = delta > 0 ? delta : 0;
	}

	function handlePointerUp() {
		if (!dragging) return;
		dragging = false;
		if (dragY > DISMISS_THRESHOLD) {
			onClose();
		}
		dragY = 0;
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if open}
	<div class="fixed inset-0 z-40 lg:hidden" role="presentation">
		<div
			class="absolute inset-0 bg-zinc-950/45"
			onclick={handleBackdropClick}
			role="presentation"
			transition:fade={{ duration: motionDuration(SHEET_FADE_MS) }}
		></div>

		<div
			bind:this={sheetEl}
			role="dialog"
			aria-modal="true"
			aria-label={ariaLabel}
			tabindex="-1"
			onkeydown={handleSheetKeydown}
			class="absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col overflow-hidden rounded-t-3xl bg-white shadow-[0_-8px_30px_rgba(0,0,0,0.18)] transition-transform duration-200 ease-out"
			style:transform={dragY !== 0 ? `translateY(${dragY}px)` : undefined}
			style:transition={dragging ? 'none' : undefined}
			transition:fly={{ y: 300, duration: motionDuration(SHEET_FLY_MS) }}
		>
			<div
				role="separator"
				aria-hidden="true"
				class="flex min-h-[28px] w-full shrink-0 cursor-grab touch-none items-center justify-center pt-2.5 pb-1 active:cursor-grabbing"
				onpointerdown={handlePointerDown}
				onpointermove={handlePointerMove}
				onpointerup={handlePointerUp}
				onpointercancel={handlePointerUp}
			>
				<span class="h-1 w-9 rounded-full bg-zinc-300"></span>
			</div>

			<div class="flex-1 overflow-y-auto overscroll-contain px-5 pb-6">
				{@render children()}
			</div>
		</div>
	</div>
{/if}
