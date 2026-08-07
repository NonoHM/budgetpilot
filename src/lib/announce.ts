/**
 * A polite live-region announcer for a value that changes on every keystroke.
 *
 * The problem it exists for, from design 1p: an `aria-live="polite"` placed naively on the
 * remainder amount reads « 8, 80, 800, 80, 8 » while the user types « 8,00 ». The answer is three
 * rules, and none of them is visible in a rendered page — which is what makes this the piece that
 * fails by staying green. A broken announcer produces either a screen reader that never stops
 * talking or one that says nothing at all, and both render identically.
 *
 * So the policy lives here, apart from any component, with the clock injected by the test:
 *
 *  1. The rewrite happens only after a typing PAUSE (700 ms), or immediately on `flush()` — which
 *     the caller wires to a field's `blur`. Typing straight through produces exactly one
 *     announcement, at the end.
 *  2. A rewrite is SUPPRESSED when the sentence is identical to the one last announced. Typing a
 *     character and deleting it again lands back on the same sentence and must stay silent.
 *  3. The visible element the sentence describes is `aria-hidden`, and `aria-describedby` points
 *     HERE and only here. An `aria-hidden` element takes its descendants out of the accessibility
 *     tree, so a `describedby` aimed at it exposes nothing reliably across browsers. That half is
 *     the caller's job; this module owns the timing.
 *
 * Deliberately framework-free. It reports through `onChange` rather than owning a rune, so its
 * behaviour can be asserted with fake timers and no component in the way — the announcer is the
 * thing under test, not the panel that happens to use it.
 */

/** Design 1p: « n'est réécrite qu'après une pause de saisie de 700 ms ». */
export const ANNOUNCE_PAUSE_MS = 700;

export interface PoliteAnnouncer {
	/** The sentence currently in the live region. Empty until the first announcement lands. */
	readonly announced: string;
	/** Ask for `sentence` to be announced once the typing pause has elapsed. Resets the pause. */
	schedule(sentence: string): void;
	/** Announce the pending sentence NOW — wire this to `blur`. No-op when nothing is pending. */
	flush(): void;
	/** Drop anything pending without announcing it. Wire to teardown. */
	cancel(): void;
}

export function createPoliteAnnouncer(options: {
	onChange: (sentence: string) => void;
	pauseMs?: number;
	/**
	 * The sentence the region ALREADY shows at mount, recorded without announcing it.
	 *
	 * A `role="status"` region that is created holding text does not speak; one that is created
	 * empty and then filled does. So the state a panel OPENS in has to be the region's initial
	 * render — otherwise opening the editor speaks « Reste à répartir, 80,00 euros » on top of the
	 * dialog's own announcement, for a state the user has not caused. Passing it here is what stops
	 * the first `schedule()` of that same sentence from being treated as a change.
	 */
	initial?: string;
}): PoliteAnnouncer {
	const pauseMs = options.pauseMs ?? ANNOUNCE_PAUSE_MS;
	let announced = options.initial ?? '';
	let pending: string | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	function clear() {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function commit() {
		clear();
		if (pending === null) return;
		const next = pending;
		pending = null;
		// Rule 2. Compared against what was last ANNOUNCED, never against what was last scheduled:
		// scheduling A then B then A again must stay silent, and comparing to the previous *schedule*
		// would announce the third one.
		if (next === announced) return;
		announced = next;
		options.onChange(next);
	}

	return {
		get announced() {
			return announced;
		},
		schedule(sentence: string) {
			pending = sentence;
			clear();
			timer = setTimeout(commit, pauseMs);
		},
		flush() {
			commit();
		},
		cancel() {
			clear();
			pending = null;
		}
	};
}
