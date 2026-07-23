// Shared focus-management helpers for modal-like overlays (Modal, BottomSheet).
// Extracted so the two components never drift apart on what counts as
// "focusable" or on how the Tab trap cycles — they carry aria-modal="true",
// so keyboard focus must never escape them while open.

const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Visible focusable descendants of `container`, in DOM order. The offsetParent
// check drops display:none elements (e.g. the desktop-only half of a dual
// mobile/desktop DOM) that would otherwise receive focus invisibly.
export function getFocusable(container: HTMLElement | null): HTMLElement[] {
	if (!container) return [];
	return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		(el) => el.offsetParent !== null
	);
}

// Focus the first focusable descendant, falling back to the container itself
// (both overlays render their panel with tabindex="-1" for exactly this case).
export function focusFirst(container: HTMLElement | null): void {
	const focusable = getFocusable(container);
	if (focusable.length > 0) {
		focusable[0].focus();
	} else {
		container?.focus();
	}
}

// Remembers the element focused before an overlay opened, and restores it on
// close. restore() is idempotent — safe to call from both the close branch and
// the destroy cleanup ({#if}-removal) without double-focusing.
export function createFocusRestore(): { save: () => void; restore: () => void } {
	let previous: HTMLElement | null = null;
	return {
		save(): void {
			const active = document.activeElement as HTMLElement | null;
			// <body> means focus was already lost when the overlay opened (e.g. the
			// overlay was opened by a navigation, which resets focus) — restoring it
			// would only fight whoever re-establishes focus after close. Save nothing.
			previous = active === document.body ? null : active;
		},
		restore(): void {
			previous?.focus();
			previous = null;
		}
	};
}

// Tab trap: keep focus cycling first↔last inside `container`. Call from the
// container's keydown handler; non-Tab keys pass through untouched.
export function trapTabKey(event: KeyboardEvent, container: HTMLElement | null): void {
	if (event.key !== 'Tab') return;
	const focusable = getFocusable(container);
	if (focusable.length === 0) return;
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	if (event.shiftKey) {
		if (document.activeElement === first) {
			event.preventDefault();
			last.focus();
		}
	} else {
		if (document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}
}
