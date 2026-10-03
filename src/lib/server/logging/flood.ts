/**
 * Flood summarisation: the log must not be the amplifier.
 *
 * An event a visitor can trigger without a session (a page that does not exist, an unexpected
 * error) would otherwise write one line per request, so a loop of requests becomes a loop of disk
 * writes. OWASP's Logging Cheat Sheet: « Ensure logging cannot be used to deplete system
 * resources ». Within one window, the first ALLOWANCE lines of a key are written and the rest are
 * counted, and when the window closes one `budgetpilot.log.suppressed` line says how many.
 *
 * The key is built by the caller from closed fields only (the event name, and a status code where
 * the event has one), so the number of keys, and the memory this holds, is bounded by the
 * registry rather than by what visitors send.
 *
 * Imported by `boot.mjs` as TypeScript source: erasable syntax only.
 */

export const FLOOD_WINDOW_MS = 60_000;
export const FLOOD_ALLOWANCE = 20;

interface Window {
	start: number;
	seen: number;
	suppressed: number;
}

export interface FloodGateOptions {
	now: () => number;
	/** Runs `run` after `ms`; must not keep the process alive. */
	schedule: (run: () => void, ms: number) => void;
	windowMs?: number;
	allowance?: number;
}

/** Returns `admit(key)`: true when the line is written, false when it is counted instead. */
export function createFloodGate(
	summarise: (key: string, suppressed: number, windowSeconds: number) => void,
	options: FloodGateOptions
): (key: string) => boolean {
	const windowMs = options.windowMs ?? FLOOD_WINDOW_MS;
	const allowance = options.allowance ?? FLOOD_ALLOWANCE;
	const windows = new Map<string, Window>();

	const close = (key: string, window: Window) => {
		if (windows.get(key) !== window) return;
		windows.delete(key);
		if (window.suppressed > 0) summarise(key, window.suppressed, windowMs / 1000);
	};

	return (key) => {
		const now = options.now();
		const current = windows.get(key);
		if (current && now - current.start >= windowMs) close(key, current);

		const window = windows.get(key);
		if (!window) {
			windows.set(key, { start: now, seen: 1, suppressed: 0 });
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
}
