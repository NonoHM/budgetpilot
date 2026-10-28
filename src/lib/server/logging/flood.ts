/**
 * Flood summarisation: the log must not be the amplifier.
 *
 * An event a visitor can trigger without a session (a page that does not exist, an unexpected
 * error) would otherwise write one line per request, so a loop of requests becomes a loop of disk
 * writes. OWASP's Logging Cheat Sheet: « Ensure logging cannot be used to deplete system
 * resources ». Within one window, the first ALLOWANCE lines of a key are written and the rest are
 * counted, and when the window closes one `budgetpilot.log.suppressed` line says how many.
 *
 * The key is built by the caller from bounded fields only (the event name, the status, the route
 * template and the error class), so the number of keys, and the memory this holds, is bounded by
 * the code rather than by what visitors send. The route and the class are in the key so that one
 * repeated failure cannot swallow a different one in the same minute (contradiction pass on L2).
 *
 * Imported by `boot.mjs` as TypeScript source: erasable syntax only.
 */

export const FLOOD_WINDOW_MS = 60_000;
export const FLOOD_ALLOWANCE = 20;

interface Window<Label> {
	start: number;
	seen: number;
	suppressed: number;
	label: Label;
}

export interface FloodGateOptions {
	now: () => number;
	/** Runs `run` after `ms`; must not keep the process alive. */
	schedule: (run: () => void, ms: number) => void;
	windowMs?: number;
	allowance?: number;
}

/**
 * Returns `admit(key, label)`: true when the line is written, false when it is counted instead.
 * `label` describes the key for the summary line and is kept from the first line of each window.
 * `admit.flush()` closes every open window now; the timer of a window it closed then does nothing.
 */
export function createFloodGate<Label>(
	summarise: (label: Label, suppressed: number, windowSeconds: number) => void,
	options: FloodGateOptions
): ((key: string, label: Label) => boolean) & { flush: () => void } {
	const windowMs = options.windowMs ?? FLOOD_WINDOW_MS;
	const allowance = options.allowance ?? FLOOD_ALLOWANCE;
	const windows = new Map<string, Window<Label>>();

	// The summary names the seconds the window ran, from its first line, rounded up, 1 to the window
	// (owner rulings on #866): a window cut short by a stop is no longer reported as a full minute.
	const close = (key: string, window: Window<Label>) => {
		if (windows.get(key) !== window) return;
		windows.delete(key);
		if (window.suppressed === 0) return;
		const covered = Math.ceil((options.now() - window.start) / 1000);
		summarise(window.label, window.suppressed, Math.min(windowMs / 1000, Math.max(1, covered)));
	};

	const admit = (key: string, label: Label): boolean => {
		const now = options.now();
		const current = windows.get(key);
		if (current && now - current.start >= windowMs) close(key, current);

		const window = windows.get(key);
		if (!window) {
			windows.set(key, { start: now, seen: 1, suppressed: 0, label });
			return true;
		}
		window.seen += 1;
		if (window.seen <= allowance) return true;
		window.suppressed += 1;
		if (window.suppressed === 1) {
			options.schedule(() => close(key, window), window.start + windowMs - now);
		}
		return false;
	};

	/** Writes every open window's summary now, for a process about to stop (#866, #1085). */
	const flush = () => {
		for (const [key, window] of windows) close(key, window);
	};

	return Object.assign(admit, { flush });
}
