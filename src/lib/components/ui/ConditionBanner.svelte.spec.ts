import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import ConditionBanner from './ConditionBanner.svelte';

/**
 * BREAK MATRIX, read per test, run 2026-08-15.
 *
 * 1. Remove `border-t`, which is the mistake the design document itself made twice by counting the
 *    content and forgetting the border: **four red at 63.** One pixel, and it is the whole reason
 *    64 is pinned absolutely rather than left to a comparison between states: every state would
 *    have agreed at 63.
 * 2. `py-3` to `py-2`: **four red at 56.**
 * 3. Give the complete state an emerald glyph instead of a black one: **one red**, reading
 *    `oklch(0.596 0.145 163.225)` against the page ink `oklch(0.21 0.006 285.885)`. Nothing else
 *    moves, correctly, because colour is not geometry, which is why the colour has its own test.
 * 4. Drop the `id` from the consequence line: **two red**, both `aria-describedby` tests. A dangling
 *    `aria-describedby` is silent and looks identical in markup to a working one, so nothing else
 *    could have caught it.
 */
const BASE = {
	label: 'Colonnes à désigner',
	count: '0 sur 3',
	consequence: 'Date, libellé et montant. La catégorie est optionnelle.',
	consequenceId: 'columns-condition-consequence'
};

function mount(props: Record<string, unknown> = {}) {
	const { container } = render(ConditionBanner, { ...BASE, ...props });
	container.style.width = '390px';
	const banner = container.querySelector('[data-testid="condition-banner"]') as HTMLElement;
	expect(banner).not.toBeNull();
	return { container, banner };
}

describe('ConditionBanner.svelte: 64 px, and the hairline is inside it', () => {
	it('is 64 px, not 62: the 1 px top border is part of the box', () => {
		//  1 hairline + 12 padding + 20 line 1 + 2 gap + 17 line 2 + 12 padding = 64.
		// The subtraction to 62 was made twice in one document by counting only the content. A
		// border is inside its box, and this assertion is the only thing that says so out loud.
		const { banner } = mount();

		expect(banner.getBoundingClientRect().height).toBe(64);
		expect(getComputedStyle(banner).borderTopWidth).toBe('1px');
	});

	it('renders both states and compares them, which is the assertion the pinned 64 cannot make', () => {
		// The plan asks for BOTH forms and they answer different questions. The absolute 64 says the
		// figure is right; this says the two states agree, which is what the layout actually needs
		// and which an absolute assertion per state cannot express directly.
		//
		// It is second, never alone: a comparison passes with no stylesheet loaded at all, because
		// both sides fall back to the same defaults. Paired with the absolute figure it is safe.
		const incomplete = mount({ complete: false });
		const incompleteHeight = incomplete.banner.getBoundingClientRect().height;
		incomplete.container.remove();

		const complete = mount({
			complete: true,
			label: 'Les trois colonnes sont désignées',
			count: '3 sur 3',
			consequence: 'Catégorie incluse. 11 colonnes seront ignorées.'
		});

		expect(complete.banner.getBoundingClientRect().height).toBe(incompleteHeight);
		expect(incompleteHeight).toBe(64);
	});

	it('is 64 px in the complete state too, so the body above it never moves', () => {
		// This banner sits OUTSIDE the scrolling area, between the 636 px body and the footer. If it
		// changed height between states, the body would change with it and "nothing scrolls" would
		// hold in some states and not others.
		const { banner } = mount({
			complete: true,
			label: 'Les trois colonnes sont désignées',
			count: '3 sur 3',
			consequence: 'Catégorie incluse. 11 colonnes seront ignorées.'
		});

		expect(banner.getBoundingClientRect().height).toBe(64);
	});

	it('is 64 px during analysis, where the count is a dash rather than a number', () => {
		// `count` is a string for exactly this state. A numeric prop would push the caller into
		// rendering the dash some other way, which is how a second layout appears for one state.
		//
		// The em dash below is the PLACEHOLDER GLYPH for an unknown value, not prose, and it is
		// pinned here on purpose, exactly as `FilterDropdown.svelte.spec.ts` pins the same glyph.
		// The repository's no-em-dash rule is about sentences and has no answer for this; the
		// decision is open and recorded as open. This is an eighth site of it. Both catalogues stay
		// at zero: nothing here reaches `messages/*.json`.
		const { banner } = mount({
			label: 'Analyse du fichier',
			count: '—',
			consequence: 'Lecture des colonnes et des premières lignes.'
		});

		expect(banner.getBoundingClientRect().height).toBe(64);
	});

	it('holds 64 px against a consequence long enough to wrap a narrower box', () => {
		// The height must not depend on copy length, because copy length depends on translation.
		const { banner } = mount({
			consequence:
				'Il reste la date et le montant, et deux colonnes portent une date, ce qui fait de cette phrase la plus longue que cet écran puisse produire.'
		});

		expect(banner.getBoundingClientRect().height).toBe(64);
		// The absolute figure beside the invariance: a banner rendering nothing also holds still.
		expect(banner.getBoundingClientRect().width).toBe(390);
	});
});

describe('ConditionBanner.svelte: the complete glyph is black, not green', () => {
	it('paints the check the same ink as the count, which is the page ink and not a status colour', () => {
		// Green is one of the product's two tinted surfaces and it is spent on success, meaning
		// something happened. Nothing has happened here: three columns are designated, which is a
		// fact about the form.
		//
		// Compared against the COUNT rather than against a colour literal retyped into this file.
		// A retyped literal is a copy certifying the original, and Tailwind v4 emits `oklch`, so the
		// literal would also have pinned a serialisation this test has no opinion about.
		const { banner } = mount({ complete: true });

		const glyph = banner.querySelector('svg') as SVGElement;
		const count = banner.querySelector('.tabular-nums') as HTMLElement;
		const label = banner.querySelector('span > span.truncate') as HTMLElement;
		expect(glyph).not.toBeNull();
		expect(count).not.toBeNull();
		expect(label).not.toBeNull();

		// Assert the difference BEFORE the property. Without this the equality below would hold in a
		// world where every element on the page computes to the same colour, which is exactly the
		// world with no stylesheet in it.
		expect(getComputedStyle(count).color).not.toBe(getComputedStyle(label).color);
		expect(getComputedStyle(glyph).color).toBe(getComputedStyle(count).color);
		expect(glyph.getAttribute('aria-hidden')).toBe('true');
	});

	it('draws no glyph at all when the condition is not met', () => {
		// The presence half sits in the test above: the detector is known to find a glyph when
		// there is one, so finding none here is a fact about the state rather than about the query.
		const { banner } = mount({ complete: false });

		expect(banner.querySelectorAll('svg').length).toBe(0);
	});

	it('uses no tinted surface in either state, measured as chroma rather than as a class name', () => {
		// An unrecognised file comes from a bank we have not seen; a renamed column comes from the
		// bank's own site update. None of it is an act of the user, so none of it is painted.
		//
		// "Untinted" is measured as ACHROMATIC, which is what the word means, rather than by
		// matching a class name or a colour literal. Tailwind v4 emits `oklch(L C H)` and the C is
		// the tint.
		const chromaOf = (el: Element): number => {
			const parsed = /^oklch\(\s*[\d.]+%?\s+([\d.]+|none)\s/.exec(
				getComputedStyle(el).backgroundColor
			);
			expect(parsed, `unparsed background: ${getComputedStyle(el).backgroundColor}`).not.toBeNull();
			return parsed![1] === 'none' ? 0 : Number(parsed![1]);
		};

		// CALIBRATION FIRST. A detector that returns 0 for everything, including a genuinely tinted
		// surface, would pass the assertions below while reading nothing. Pointed at a real tint,
		// written inline so it does not depend on Tailwind having generated the class.
		const probe = document.createElement('div');
		probe.style.backgroundColor = 'oklch(0.95 0.05 20)';
		document.body.appendChild(probe);
		expect(chromaOf(probe)).toBeCloseTo(0.05, 3);
		probe.remove();

		for (const complete of [false, true]) {
			const { banner, container } = mount({ complete });
			expect(chromaOf(banner), `complete=${complete}`).toBe(0);
			container.remove();
		}
	});
});

describe('ConditionBanner.svelte: one reason location per disabled control', () => {
	it('carries the consequence on an element the primary can point at by id', () => {
		// The blocked primary is `aria-disabled="true"` with `aria-describedby` aimed HERE, at the
		// second line, and never at a reason line under the button: the cause is a count, and the
		// count is displayed here.
		const { banner } = mount();

		const target = banner.querySelector('#columns-condition-consequence');
		expect(target).not.toBeNull();
		expect(target?.textContent?.trim()).toBe(BASE.consequence);
	});

	it('resolves the reference from a control that really points at it', () => {
		// A dangling `aria-describedby` is silent and looks identical in markup to a working one, so
		// the reference is RESOLVED here rather than assumed: the button is built, pointed at the id,
		// and the lookup is performed the way an assistive technology performs it.
		const { container } = mount();

		const primary = document.createElement('button');
		primary.setAttribute('aria-disabled', 'true');
		primary.setAttribute('aria-describedby', BASE.consequenceId);
		container.appendChild(primary);

		const described = document.getElementById(primary.getAttribute('aria-describedby') as string);
		expect(described).not.toBeNull();
		expect(described?.textContent?.trim()).toBe(BASE.consequence);
		// Never the `disabled` attribute: it takes the control out of the accessibility tree and
		// takes its explanation with it.
		expect(primary.hasAttribute('disabled')).toBe(false);
	});
});

describe('ConditionBanner.svelte: the count', () => {
	it('is tabular so it does not jitter as it climbs from 0 to 3', () => {
		const { banner } = mount({ count: '3 sur 3' });

		const count = banner.querySelector('.tabular-nums') as HTMLElement;
		expect(count).not.toBeNull();
		expect(count.textContent?.trim()).toBe('3 sur 3');
		expect(getComputedStyle(count).fontVariantNumeric).toContain('tabular-nums');
	});
});
