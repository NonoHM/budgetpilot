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
		children,
		header,
		footer
	}: {
		open?: boolean;
		ariaLabel: string;
		onClose: () => void;
		children: Snippet;
		/**
		 * REQUIRED persistent header, rendered OUTSIDE the scrolling body — the mirror of `footer`,
		 * and for the same reason. A title and a route back that scroll away with the content leave a
		 * reader who has scrolled the grid with no visible way out of the sheet, which is exactly the
		 * argument that makes the footer sticky: *in a sheet the primary action never scrolls, and by
		 * the same reasoning the way back never scrolls either.*
		 *
		 * Required rather than conventional, deliberately. It shipped optional with the Période sheet
		 * and stayed at one consumer: the four other sheets went on rendering their `<h2>` as the
		 * first thing inside `children`, where it scrolls away. Measured 2026-08-07 at 390x844, both
		 * on the live pages: the transaction detail title travelled **247 px** out of the sheet, the
		 * category sub-sheet's **165 px**. The Filtres sheet's title held still only because its body
		 * happened to be 174 px tall and did not scroll at all — not a guarantee, an accident of how
		 * many filters exist today. A convention cannot see a call site that never adopted it; a
		 * required prop is refused by `npm run check` by name.
		 *
		 * Height: 57 px measured on the Période sheet, which with the 28 px handle is the 85 px the
		 * referential's V2 errata records. The design's 73 px is superseded and is not to be restored.
		 */
		header: Snippet;
		/**
		 * Optional sticky footer, rendered OUTSIDE the scrolling body — see the "pied de feuille" rule
		 * below. Optional and not required, unlike `header`, because it is not universal: the sub-sheets
		 * dismiss on selection and have no primary action to pin. A sheet that HAS one must use this.
		 */
		footer?: Snippet;
	} = $props();

	let sheetEl = $state<HTMLElement | null>(null);
	const focusRestore = createFocusRestore();

	let dragging = $state(false);
	let dragY = $state(0);
	let startY = 0;

	// Pied de feuille (design 6M): the primary action never scrolls, including
	// when the virtual keyboard shrinks the sheet. `visualViewport` is the only
	// signal that reports the SHRUNK visible area on a phone — the layout
	// viewport (what `100vh`/`vh` units and plain `fixed` positioning measure)
	// stays the same size and simply gets pushed off-screen by the keyboard, so
	// a `fixed inset-0` wrapper would carry the header off the top and the
	// footer under the keyboard instead of resizing. `100dvh` doesn't help here
	// either: it tracks browser-chrome changes, not the on-screen keyboard, on
	// every engine this app targets.
	//
	// `viewportBox` is null in two cases that must both fall back to today's
	// static behaviour: `visualViewport` doesn't exist (jsdom, older browsers),
	// or the sheet is closed (no listeners attached, nothing to compute from).
	let viewportBox = $state<{ top: number; height: number } | null>(null);

	function readViewportBox(vv: VisualViewport): { top: number; height: number } {
		return { top: vv.offsetTop, height: vv.height };
	}

	$effect(() => {
		if (!open) {
			viewportBox = null;
			return;
		}
		const vv = typeof window !== 'undefined' ? window.visualViewport : null;
		if (!vv) {
			viewportBox = null;
			return;
		}
		const update = () => {
			viewportBox = readViewportBox(vv);
		};
		update();
		vv.addEventListener('resize', update);
		vv.addEventListener('scroll', update);
		return () => {
			vv.removeEventListener('resize', update);
			vv.removeEventListener('scroll', update);
		};
	});

	// Never leave a focused field under the keyboard: scroll it into the
	// scrolling body's own visible area (never past the sticky footer, since
	// the footer sits outside this element entirely).
	function handleBodyFocusIn(event: FocusEvent) {
		const target = event.target as HTMLElement | null;
		if (!target) return;
		if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
		target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

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

	/**
	 * A sheet keeps a sliver of backdrop above it, so it reads as a sheet over the page rather than
	 * as a new full-screen page — 6M budgets 809 of 844, a 35px gap. That gap is dropped once the
	 * visual viewport has shrunk, because then every pixel belongs to the keyboard case and the
	 * design's own table has the sheet filling the reduced viewport exactly (544 of 544).
	 */
	/**
	 * NEVER TESTED ON A REAL DEVICE. Stated because the whole keyboard behaviour below rests on it.
	 *
	 * `visualViewport` resize is emulated everywhere it is covered: headless Chromium never raises a
	 * keyboard, so the specs stub the object and move it by hand, and the touch e2e runs a
	 * touch-enabled Chromium rather than a phone. That models the EVENT faithfully and says nothing
	 * about the two engines that matter:
	 *
	 *  - iOS Safari resizes `visualViewport` but does NOT resize the layout viewport, and additionally
	 *    scrolls the page when a focused field would sit under the keyboard — so `offsetTop` moves and
	 *    a position:fixed ancestor can end up translated in ways this code does not model.
	 *  - Android Chrome's behaviour depends on the `interactive-widget` viewport setting; the default
	 *    (`resizes-visual`) matches what is assumed here, but `resizes-content` does not.
	 *
	 * The blast radius is proven non-zero: this mechanism silently replaced the app-wide `max-h-[85vh]`
	 * cap for every sheet and no test noticed until it was measured by hand. So treat a real-device
	 * pass on both engines as outstanding work, not as a formality.
	 */
	const BACKDROP_GAP_PX = 35;
	const sheetMaxHeight = $derived.by(() => {
		if (!viewportBox) return undefined;

		// The keyboard case: every remaining pixel belongs to it, and 6M's table has the sheet
		// filling the reduced viewport exactly (544 of 544). Applies to every sheet — a shrunken
		// viewport is a constraint, never a licence to grow.
		const keyboardIsUp = viewportBox.height < window.innerHeight - 1;
		if (keyboardIsUp) return '100%';

		/**
		 * Otherwise the near-full height is scoped to sheets that carry a STICKY FOOTER, and the
		 * other four sheets in this app keep the `max-h-[85vh]` they have always had.
		 *
		 * This is not caution, it is the footer rule read in the other direction. 85vh exists so a
		 * tall sheet cannot bury its primary action below the fold; a sticky footer removes that
		 * risk by construction, which is what makes the extra height safe to hand out. Without one,
		 * a taller sheet is simply more scrolling with the action buried deeper — exactly what the
		 * cap was protecting against.
		 *
		 * It also matters because the `visualViewport` work silently replaced that cap for every
		 * sheet (85vh → 100%, +127px at 844) and no test noticed. Only Période asked for the change.
		 */
		if (!footer) return undefined;
		return `${Math.max(320, viewportBox.height - BACKDROP_GAP_PX)}px`;
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
	<div
		class="fixed inset-0 z-40 flex flex-col justify-end lg:hidden"
		style:top={viewportBox ? `${viewportBox.top}px` : undefined}
		style:height={viewportBox ? `${viewportBox.height}px` : undefined}
		style:bottom={viewportBox ? 'auto' : undefined}
		role="presentation"
	>
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
			class="relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-[0_-8px_30px_rgba(0,0,0,0.18)] transition-transform duration-200 ease-out"
			style:max-height={viewportBox ? sheetMaxHeight : undefined}
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

			<div class="shrink-0 border-b border-zinc-100 bg-white px-5 pb-3">
				{@render header()}
			</div>

			<div
				class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-3 {footer
					? 'pb-4'
					: 'pb-6'}"
				onfocusin={handleBodyFocusIn}
			>
				{@render children()}
			</div>

			{#if footer}
				<div
					class="shrink-0 border-t border-zinc-100 bg-white px-5 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]"
				>
					{@render footer()}
				</div>
			{/if}
		</div>
	</div>
{/if}
