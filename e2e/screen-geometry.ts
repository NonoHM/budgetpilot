import { expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * The two assertions a human's eye makes and an end-to-end journey does not.
 *
 * Extracted from `import-column-designation.spec.ts`, where both were written, so that the three
 * import specs share ONE copy. `expectPrimaryUnobstructed` encodes a rule about the running
 * application, and a rule retyped in a second spec is the copied-predicate failure one level up:
 * the two versions agree today and the day they stop, nothing is watching.
 */

/**
 * Text that is actually ON SCREEN, not merely in the document.
 *
 * Every page in this application renders a desktop and a mobile layout and hides one with CSS, so a
 * bare `getByText(...).first()` resolves to whichever copy comes first in the DOM, which at 390 is
 * the hidden one. The failure then reads « the text is missing » while the text is present and
 * correct, and the real cause is the assertion, not the page. Three assertions were written that
 * way and all three failed on a working flow before this helper existed.
 */
export function onScreen(page: Page, text: string) {
	return page.getByText(text).filter({ visible: true }).first();
}

/**
 * The assertion a human's eye would fail, and the one an end-to-end journey does not make.
 *
 * Playwright clicks what a human cannot see. The designation screen's journey passed for two days
 * while the bottom tab bar was painted straight over the action footer and the import control was
 * half covered. A test that only asks whether the journey TERMINATES cannot see that; a human
 * asking whether it can be PERFORMED sees nothing else.
 *
 * So: read the primary's box and every fixed or sticky element on the page, and assert they do not
 * intersect. Four lines, at each width.
 */
export async function expectPrimaryUnobstructed(page: Page, label: RegExp) {
	const primary = await page.getByRole('button', { name: label }).first().boundingBox();
	expect(primary).not.toBeNull();

	// FULLY INSIDE THE VIEWPORT, and this is the half that catches the real defect. The app chrome
	// added `pb-32` around a screen that builds its own full-height stack, so the action footer was
	// pushed BELOW the fold: the primary was not covered, it was off-screen, and the page scrolled
	// to reveal a sliver of it. An overlap scan alone reports nothing, because nothing overlaps.
	const viewport = page.viewportSize();
	expect(viewport).not.toBeNull();
	expect(primary!.y + primary!.height, 'the primary is below the fold').toBeLessThanOrEqual(
		viewport!.height
	);
	expect(primary!.y, 'the primary is above the fold').toBeGreaterThanOrEqual(0);

	const obstructions = await page.evaluate((label) => {
		const primaryEl = [...document.querySelectorAll('button')].find((el) =>
			new RegExp(label).test(el.textContent ?? '')
		);
		return [...document.querySelectorAll('body *')]
			.filter((el) => {
				const position = getComputedStyle(el).position;
				if (position !== 'fixed' && position !== 'sticky') return false;
				// An ANCESTOR cannot cover its own child. The desktop layout deliberately makes the
				// banner-and-actions box sticky, and that box CONTAINS the primary: counting it would
				// report the intended design as the defect.
				return !(primaryEl && el.contains(primaryEl));
			})
			.map((el) => {
				const box = el.getBoundingClientRect();
				return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
			})
			.filter((box) => box.bottom > box.top && box.right > box.left);
	}, label.source);

	// CALIBRATE THE DETECTOR, NOT THE PAGE. The first version asserted the page carried at least
	// one fixed element, and that fired after the fix removed the app chrome from this route: the
	// page legitimately has none. What has to be proved is that the SCAN would see an overlap if
	// there were one, so one is injected over the primary, detected, and removed.
	const detected = await page.evaluate((rect) => {
		const probe = document.createElement('div');
		probe.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px`;
		document.body.appendChild(probe);
		const box = probe.getBoundingClientRect();
		const seen =
			rect.x < box.right &&
			rect.x + rect.width > box.left &&
			rect.y < box.bottom &&
			rect.y + rect.height > box.top;
		probe.remove();
		return seen;
	}, primary!);
	expect(detected, 'the overlap scan cannot see a deliberate overlap').toBe(true);

	for (const box of obstructions) {
		const overlaps =
			primary!.x < box.right &&
			primary!.x + primary!.width > box.left &&
			primary!.y < box.bottom &&
			primary!.y + primary!.height > box.top;
		expect(overlaps, `a fixed or sticky element covers the primary: ${JSON.stringify(box)}`).toBe(
			false
		);
	}
}
