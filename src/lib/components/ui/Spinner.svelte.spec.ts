import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Spinner from './Spinner.svelte';

// Collects the declarations of every `@media (prefers-reduced-motion: reduce)`
// rule found in the document's real (browser-parsed) stylesheets, regardless
// of the OS/browser's actual reduced-motion setting — this checks the CSS
// rule genuinely exists and freezes the animation, not just that the source
// text looks right.
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

describe('Spinner.svelte', () => {
	it('is purely decorative (aria-hidden svg icon)', async () => {
		const { container } = render(Spinner, {});

		const svg = container.querySelector('svg');
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute('aria-hidden')).toBe('true');
	});

	it('defaults to a 14px size', async () => {
		const { container } = render(Spinner, {});

		const svg = container.querySelector('svg') as SVGElement;
		expect(svg.style.width).toBe('14px');
		expect(svg.style.height).toBe('14px');
	});

	it('applies a custom size', async () => {
		const { container } = render(Spinner, { size: 28 });

		const svg = container.querySelector('svg') as SVGElement;
		expect(svg.style.width).toBe('28px');
		expect(svg.style.height).toBe('28px');
	});

	it('exposes the rotation speed as a CSS custom property consumed by the keyframe animation', async () => {
		const { container } = render(Spinner, { speedMs: 900 });

		const svg = container.querySelector('svg') as SVGElement;
		expect(svg.style.getPropertyValue('--spinner-duration')).toBe('900ms');
	});

	it('freezes the rotation to a static icon under prefers-reduced-motion (never just slowed down)', async () => {
		render(Spinner, {});

		const declarations = reducedMotionRuleDeclarations();
		expect(declarations).toContain('spinner-icon');
		// Chromium expands the `animation: none` shorthand to its longhand form;
		// the animation-name longhand (last value) is what actually disables it.
		expect(declarations).toMatch(/spinner-icon[^}]*animation:[^;]*\bnone\s*running\s*none/);
	});
});
