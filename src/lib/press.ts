// The pressed state, and the reason it is a module rather than an `:active` rule.
//
// ## The finding
//
// The component referential defines a pressed state for NO tone, having never written a surface
// without hover. On such a surface a control that does not light up under the finger is presumed
// dead. The measurement that revealed it is also the argument: the blind tester took four attempts
// to find the mobile delete, and the control had been reached on the first one. Nothing moved fast
// enough for the press to read as received. So it is not a discoverability defect, it is an
// acknowledgement defect, and it is transverse rather than proper to that screen.
//
// ## The timing rule, which is the whole of why this is code
//
//     entry     no transition
//     exit      120 ms ease-out
//     minimum   120 ms of display, even when the next screen opens sooner
//
// The referential's 120 ms ease-out is written for HOVER, where the pointer stays. Applied to a
// press it IS the defect: a 90 ms tap shows almost nothing.
//
// `:active` can express none of the three. It cannot hold a minimum display time, it cannot be
// removed by `pointercancel` while the finger is still down, and it cannot be asserted without
// driving a real pointer. The entry and exit halves are CSS (see `pressTransition` in
// `$lib/styles.ts`); the floor and the cancel path are here.
//
// Corollary held everywhere: `-webkit-tap-highlight-color` may be neutralised only where a pressed
// state replaces it, never on its own.
//
// ## Three clauses, each preventing a different regression
//
// 1. **Pressed is not selected.** It never survives `pointerup`. A control still lit after the
//    press is a bug, not a variant.
// 2. **Pressed cancels on scroll.** `pointercancel` removes it WITHOUT waiting out the floor: a tap
//    that became a drag leaves no trace.
// 3. **Pressed is mute.** No `aria-*` carries it. The value states (`aria-pressed`, `aria-checked`)
//    stay independent, which is what keeps brique 6c's switch readable before its press.
//
// Each is asserted separately in `press.svelte.spec.ts`, because each fails for a different reason.

/** The floor, and the exit duration, are the same number on purpose: one figure to remember. */
export const PRESS_MIN_MS = 120;
export const PRESS_EXIT_MS = 120;

/**
 * Marks `node` with `data-pressed` for as long as it is being pressed, and for no less than
 * `minMs` once it has been.
 *
 * A Svelte action: `<button use:pressable>`. It owns the attribute and nothing else, so what the
 * state LOOKS like stays in the class list where a designer can read it, and what it MEANS stays
 * out of the accessibility tree entirely.
 */
export function pressable(node: HTMLElement, options: { minMs?: number } = {}) {
	const minMs = options.minMs ?? PRESS_MIN_MS;
	let shownAt = 0;
	let releaseTimer: ReturnType<typeof setTimeout> | null = null;

	function clearTimer() {
		if (releaseTimer !== null) {
			clearTimeout(releaseTimer);
			releaseTimer = null;
		}
	}

	function show() {
		// The pending timer of a PREVIOUS press is cleared here rather than left to fire: without
		// this, a second press starting inside the first one's floor is erased when that timer comes
		// due, and the control goes dark under a finger that is still down.
		clearTimer();
		shownAt = Date.now();
		node.dataset.pressed = '';
	}

	function hideNow() {
		clearTimer();
		delete node.dataset.pressed;
	}

	function release() {
		if (node.dataset.pressed === undefined) return;
		const remaining = minMs - (Date.now() - shownAt);
		if (remaining <= 0) {
			hideNow();
			return;
		}
		clearTimer();
		releaseTimer = setTimeout(hideNow, remaining);
	}

	node.addEventListener('pointerdown', show);
	node.addEventListener('pointerup', release);
	node.addEventListener('pointerleave', release);
	// `hideNow` and deliberately NOT `release`: a press that became a scroll is not a press, so it
	// does not buy the floor. This is clause 2, and it is the one line that separates the two.
	node.addEventListener('pointercancel', hideNow);

	return {
		destroy() {
			hideNow();
			node.removeEventListener('pointerdown', show);
			node.removeEventListener('pointerup', release);
			node.removeEventListener('pointerleave', release);
			node.removeEventListener('pointercancel', hideNow);
		}
	};
}
