/**
 * A boolean that turns on only after `enterMs`, and once on stays on for at least `holdMs`.
 *
 * Brique 9's 300 ms is a FILTER rather than a delay: a load that beats it shows nothing, which is
 * the point. The floor is the other half and it is what makes the filter honest, because without it
 * an answer arriving at 320 ms produces a 20 ms flicker, the exact thing the entry threshold exists
 * to prevent.
 *
 * A plain module rather than a rune-carrying `.svelte.ts` state object, so it can be driven by a
 * controlled clock in a test rather than by the runner's scheduling.
 */
export function createDelayedFlag(options: { enterMs?: number; holdMs?: number } = {}) {
	const enterMs = options.enterMs ?? 300;
	const holdMs = options.holdMs ?? 300;
	let shown = $state(false);
	let shownAt = 0;
	let enterTimer: ReturnType<typeof setTimeout> | null = null;
	let exitTimer: ReturnType<typeof setTimeout> | null = null;

	function clear(timer: ReturnType<typeof setTimeout> | null) {
		if (timer !== null) clearTimeout(timer);
		return null;
	}

	return {
		get shown() {
			return shown;
		},
		/** Call with the live condition. Idempotent: repeated identical calls do not restart a timer. */
		set(active: boolean) {
			if (active) {
				exitTimer = clear(exitTimer);
				if (shown || enterTimer !== null) return;
				enterTimer = setTimeout(() => {
					enterTimer = null;
					shownAt = Date.now();
					shown = true;
				}, enterMs);
				return;
			}
			enterTimer = clear(enterTimer);
			if (!shown) return;
			const remaining = holdMs - (Date.now() - shownAt);
			if (remaining <= 0) {
				shown = false;
				return;
			}
			exitTimer = clear(exitTimer);
			exitTimer = setTimeout(() => {
				exitTimer = null;
				shown = false;
			}, remaining);
		},
		destroy() {
			enterTimer = clear(enterTimer);
			exitTimer = clear(exitTimer);
			shown = false;
		}
	};
}
