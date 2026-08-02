// WCAG relative luminance and contrast ratio for PAINTED sRGB byte triples — shared between every
// e2e spec that measures a rendered colour pair rather than a hex literal. Extracted out of
// e2e/upcoming-bills.spec.ts (task 8.3 of the transverse-tags plan) instead of copied a second
// time into e2e/tags.spec.ts, so the one implementation both specs rely on cannot drift between
// them.
//
// Operates on [r, g, b] byte triples, not hex strings: the caller is expected to have already
// resolved a Tailwind class or a `getComputedStyle` value to pixels via a canvas paint (see
// `paintedColors`/`paintTailwind` in e2e/upcoming-bills.spec.ts), because Tailwind v4 emits
// `oklch()` and `getComputedStyle` hands that back unchanged in Chromium — comparing that string
// to a hex literal would prove nothing about what the user actually sees.

export function relativeLuminance([r, g, b]: [number, number, number]): number {
	const channel = (value: number) => {
		const c = value / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
	const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
}
