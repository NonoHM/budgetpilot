import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Skeleton from './Skeleton.svelte';

// Collects the declarations of every `@media (prefers-reduced-motion: reduce)`
// rule found in the document's real (browser-parsed) stylesheets, regardless
// of the OS/browser's actual reduced-motion setting — this checks the CSS
// rule genuinely exists and freezes the pulse, not just that the source text
// looks right.
function reducedMotionRuleDeclarations(): string {
	const found: string[] = [];
	for (const sheet of Array.from(document.styleSheets)) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue;
		}
		for (const rule of Array.from(rules)) {
			if (rule instanceof CSSMediaRule && /prefers-reduced-motion/i.test(rule.conditionText)) {
				for (const inner of Array.from(rule.cssRules)) {
					found.push(inner.cssText);
				}
			}
		}
	}
	return found.join('\n');
}

describe('Skeleton.svelte', () => {
	it('is purely decorative (aria-hidden), never announced as content', async () => {
		const { container } = render(Skeleton, {});

		const root = container.firstElementChild as HTMLElement;
		expect(root.getAttribute('aria-hidden')).toBe('true');
	});

	it('mirrors ListCard slots: a pastille + two text lines + a trailing value, never a lone rectangle', async () => {
		const { container } = render(Skeleton, {});

		const pulseBlocks = container.querySelectorAll('.skeleton-pulse');
		// pastille, 2 text lines, trailing value = 4 distinct pulsing blocks.
		expect(pulseBlocks.length).toBe(4);

		const pastille = container.querySelector('.h-\\[38px\\].w-\\[38px\\]');
		expect(pastille).not.toBeNull();
		expect(pastille?.className).toContain('rounded-full');
	});

	it('accepts an extra class on the root element', async () => {
		const { container } = render(Skeleton, { class: 'my-extra-class' });

		const root = container.firstElementChild as HTMLElement;
		expect(root.className).toContain('my-extra-class');
	});

	it('freezes the pulse to a static, fully opaque placeholder under prefers-reduced-motion', async () => {
		render(Skeleton, {});

		const declarations = reducedMotionRuleDeclarations();
		expect(declarations).toContain('skeleton-pulse');
		// Chromium expands the `animation: none` shorthand to its longhand form;
		// the animation-name longhand (last value) is what actually disables it.
		expect(declarations).toMatch(/skeleton-pulse[^}]*animation:[^;]*\bnone\s*running\s*none/);
		expect(declarations).toMatch(/skeleton-pulse[^}]*opacity:\s*1/);
	});

	it('renders no phantom chip slot by default', async () => {
		const { container } = render(Skeleton, {});

		expect(container.querySelectorAll('.skeleton-pulse').length).toBe(4);
		expect(container.querySelector('[data-testid="skeleton-chips"]')).toBeNull();
	});

	it('renders a two-block phantom chip slot when chips is true, always drawn regardless of the eventual row', async () => {
		// "Always drawn" per the design: the real row's tag count is unknown while loading, and a
		// slot that only appears once the data arrives would shift the column — so this renders
		// unconditionally on `chips`, never based on any tag count (there is none to know yet).
		const { container } = render(Skeleton, { chips: true });

		const slot = container.querySelector('[data-testid="skeleton-chips"]');
		expect(slot).not.toBeNull();

		const blocks = slot!.querySelectorAll('.skeleton-pulse');
		expect(blocks.length).toBe(2);
		for (const block of Array.from(blocks)) {
			expect(block.className).toContain('w-[54px]');
		}

		// The two chip blocks join the pastille + 2 lines + value, for 6 pulsing blocks total.
		expect(container.querySelectorAll('.skeleton-pulse').length).toBe(6);
	});
});
