import { cubicIn, cubicOut } from 'svelte/easing';

// Shared transition timings — component referential V2's final brick (motion
// harmonization across Dropdown/Tooltip/Modal/AlertBanner). Entrance always
// uses ease-out (cubicOut: starts fast, slows down), exit always uses ease-in
// (cubicIn: starts slow, accelerates) — never the reverse, never a bounce.
// Skeleton's pulse and Spinner's rotation keep their own vague-1 durations
// (1.6s / 0.8-0.9s) and are intentionally not part of this token set.
export const MOTION = {
	popoverInMs: 160,
	popoverOutMs: 120,
	overlayInMs: 180,
	overlayOutMs: 140
} as const;

export const easeIn = cubicIn;
export const easeOut = cubicOut;

export function prefersReducedMotion(): boolean {
	return (
		typeof window !== 'undefined' &&
		typeof window.matchMedia === 'function' &&
		window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

// Collapses a transition duration to 0 under prefers-reduced-motion: reduce
// (instant state change), rather than merely slowing it down.
export function motionDuration(ms: number): number {
	return prefersReducedMotion() ? 0 : ms;
}
