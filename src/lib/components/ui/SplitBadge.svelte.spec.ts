import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
// Load-bearing: every geometry assertion below reads a Tailwind class. Without this the badge
// measures a UA-default inline span and the 24/22 px figures come back as something plausible and
// wrong — see CLAUDE.md, this is the class that read 44 px as 24.
import '../../../routes/layout.css';
import SplitBadge from './SplitBadge.svelte';
import * as m from '$lib/paraglide/messages';

const THREE_CATEGORIES = [
	{ category: 'Alimentation', amountCents: -6000 },
	{ category: 'Maison', amountCents: -1500 },
	{ category: 'Transport', amountCents: -500 }
];

const ONE_CATEGORY = [
	{ category: 'Alimentation', amountCents: -4000 },
	{ category: 'Alimentation', amountCents: -4000 }
];

describe('SplitBadge.svelte', () => {
	it('counts other CATEGORIES with « + » and parts with « × », so one symbol never means two things', async () => {
		expect.assertions(2);
		const { rerender } = render(SplitBadge, {
			parts: THREE_CATEGORIES,
			otherCategoryCount: 2,
			dominantCategory: 'Alimentation',
			interactive: true
		});
		await expect.element(page.getByRole('button')).toHaveTextContent('+2');

		await rerender({
			parts: ONE_CATEGORY,
			otherCategoryCount: 0,
			dominantCategory: 'Alimentation',
			interactive: true
		});
		await expect.element(page.getByRole('button')).toHaveTextContent('×2');
	});

	it('names every part in the accessible name, because the bubble is hidden from it', async () => {
		expect.assertions(2);
		render(SplitBadge, {
			parts: THREE_CATEGORIES,
			otherCategoryCount: 2,
			dominantCategory: 'Alimentation',
			interactive: true
		});

		const name = (page.getByRole('button').element() as HTMLElement).getAttribute(
			'aria-label'
		) as string;
		// The three categories AND their amounts: a name saying only "see the detail" would promise
		// something no assistive technology can reach, since the bubble is aria-hidden.
		expect(name).toContain('Maison');
		expect(name).toContain('Transport');
	});

	it('states magnitudes, never a sign, matching the editor the parts were typed into', async () => {
		expect.assertions(1);
		render(SplitBadge, {
			parts: THREE_CATEGORIES,
			otherCategoryCount: 2,
			dominantCategory: 'Alimentation',
			interactive: true
		});

		const name = (page.getByRole('button').element() as HTMLElement).getAttribute(
			'aria-label'
		) as string;
		// Every part of this fixture is negative. A minus sign anywhere in the sentence means the
		// badge is quoting stored amounts rather than what the user typed.
		expect(name).not.toMatch(/[−-]\s*\d/u);
	});

	// Appear-then-disappear: polling for an absent bubble would pass while the component had not
	// mounted, before any hover had been processed, and for a dozen reasons unrelated to the rule.
	it('opens the bubble on hover and closes it again on Escape, focus never leaving the badge', async () => {
		expect.assertions(4);
		render(SplitBadge, {
			parts: THREE_CATEGORIES,
			otherCategoryCount: 2,
			dominantCategory: 'Alimentation',
			interactive: true
		});
		const badge = page.getByRole('button');

		await userEvent.hover(badge);
		const heading = m.splits_row_tooltip_heading({ count: 3 });
		await expect.element(page.getByText(heading)).toBeInTheDocument();
		await expect.element(page.getByText('Maison 15,00 €')).toBeInTheDocument();

		await userEvent.click(badge);
		await userEvent.keyboard('{Escape}');
		await expect.element(page.getByText(heading)).not.toBeInTheDocument();
		// Escape closing a bubble must not also cost the user their place in the table.
		expect(document.activeElement).toBe(badge.element());
	});

	it('opens on FOCUS too, so the bubble is reachable without a pointer', async () => {
		expect.assertions(2);
		render(SplitBadge, {
			parts: THREE_CATEGORIES,
			otherCategoryCount: 2,
			dominantCategory: 'Alimentation',
			interactive: true
		});
		const heading = m.splits_row_tooltip_heading({ count: 3 });
		// THE POINTER DOES NOT MOVE BETWEEN TESTS. The previous test left it resting on a badge and
		// this one renders another at the same coordinates, so the browser fires a real `mouseenter`
		// at it and the bubble opens with nothing to do with focus. Moving the pointer off is what
		// makes the appearance below attributable to the mechanism under test.
		//
		// Found by break-checking, and the shape is worth the line: with `onfocus` removed the test
		// PASSED in file order and FAILED run alone — green in CI, red for whoever runs one test.
		// A synchronous `dispatchEvent(new MouseEvent('mouseleave'))` does not fix it: the browser's
		// own mouseenter arrives after the render, so the fake leave lands before the real enter.
		await page.getByRole('button').unhover();
		await expect.element(page.getByText(heading)).not.toBeInTheDocument();

		(page.getByRole('button').element() as HTMLElement).focus();
		await expect.element(page.getByText(heading)).toBeInTheDocument();
	});

	it('is not a target at 390, and still says what it is', async () => {
		expect.assertions(3);
		render(SplitBadge, {
			parts: ONE_CATEGORY,
			otherCategoryCount: 0,
			dominantCategory: 'Alimentation'
		});

		expect(page.getByRole('button').elements()).toHaveLength(0);
		// The visible « ×2 » is hidden from assistive technology and a sentence stands in its place,
		// travelling with the component rather than being owed by the caller.
		expect(document.querySelector('[aria-hidden="true"]')?.textContent?.trim()).toBe('×2');
		await expect
			.element(
				page.getByText(m.splits_row_badge_same_short({ count: 2, category: 'Alimentation' }))
			)
			.toBeInTheDocument();
	});

	it('measures 24 px as a button and 22 px as an inert span, the two figures the design ties to interactivity', async () => {
		expect.assertions(3);
		const { rerender } = render(SplitBadge, {
			parts: THREE_CATEGORIES,
			otherCategoryCount: 2,
			dominantCategory: 'Alimentation',
			interactive: true
		});
		await expect.element(page.getByRole('button')).toBeInTheDocument();
		expect((page.getByRole('button').element() as HTMLElement).getBoundingClientRect().height).toBe(
			24
		);

		await rerender({
			parts: ONE_CATEGORY,
			otherCategoryCount: 0,
			dominantCategory: 'Alimentation',
			interactive: false
		});
		const inert = document.querySelector('[aria-hidden="true"]') as HTMLElement;
		expect(inert.getBoundingClientRect().height).toBe(22);
	});

	// 1o's whole argument: the badge is free because it never adds vertical space to the line
	// hosting it. Measured rather than asserted from the class list — the tags chantier shipped a
	// component taller than its host line with a green class assertion.
	it('adds no vertical margin, which is exactly what went wrong on the tags chantier', async () => {
		expect.assertions(2);
		render(SplitBadge, {
			parts: THREE_CATEGORIES,
			otherCategoryCount: 2,
			dominantCategory: 'Alimentation',
			interactive: true
		});
		const badge = page.getByRole('button').element() as HTMLElement;
		const style = getComputedStyle(badge);
		expect(style.marginTop).toBe('0px');
		expect(style.marginBottom).toBe('0px');
	});
});
