import { expect, test } from '@playwright/test';
import { E2E_BASE_URL, E2E_LOCALE } from './config';

/**
 * Design 6L — building a range WITH A FINGER.
 *
 * Every other test of this calendar dispatches mouse events, so none of them exercises 6L at all:
 * "le doigt ne survole pas", the candidate preview must not exist, the first tap must place a lone
 * bound with no band, the second must draw the band in one change, and — the one that decides
 * whether the grid is usable on a phone at all — a DRAG must scroll the sheet and never select.
 *
 * This spec runs in its own context with `hasTouch`, so Playwright dispatches real touch events
 * rather than synthesising pointer events over a mouse. Where a gesture has no high-level API
 * (a drag, a long press) it goes through CDP `Input.dispatchTouchEvent`, which is the same channel
 * a real digitizer feeds.
 *
 * WHAT THIS STILL DOES NOT PROVE: it is emulation, not a device. It cannot speak to iOS Safari's
 * or Android Chrome's own behaviour — momentum scrolling, the 300ms tap delay, or whether either
 * fires `visualViewport` resize the way this app assumes. Those need hardware; see the limitation
 * recorded in BottomSheet.svelte.
 */

/**
 * Only the touch-relevant properties, NOT a spread device descriptor: a descriptor also carries
 * `defaultBrowserType`, which Playwright refuses inside a describe because it would force a new
 * worker — and this suite is deliberately single-worker with shared seeded state.
 */
test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

test.describe('/transactions — Période built with a finger (6L)', () => {
	async function openSheet(page: import('@playwright/test').Page) {
		await page
			.context()
			.addCookies([{ name: 'PARAGLIDE_LOCALE', value: E2E_LOCALE, url: E2E_BASE_URL }]);
		await page.goto('/transactions');
		await page.getByRole('button', { name: 'Période', exact: true }).first().click();
		await expect(page.getByRole('dialog')).toBeVisible();
	}

	/**
	 * The month ON SCREEN, taken from the first day that actually belongs to it. The grid's first
	 * cell is normally a LEADING day from the previous month (fixedWeeks keeps six rows), so reading
	 * `[data-bits-day]` blindly picks the wrong month and every subsequent selector misses.
	 */
	async function visibleMonth(page: import('@playwright/test').Page) {
		const value = await page
			.locator('[data-bits-day]:not([data-outside-month])')
			.first()
			.getAttribute('data-value');
		return value!.slice(0, 7);
	}

	/** Absolute page coordinates of a day cell, for CDP touch dispatch. */
	async function cellPoint(page: import('@playwright/test').Page, iso: string) {
		const box = await page.locator(`[data-bits-day][data-value="${iso}"]`).boundingBox();
		if (!box) throw new Error(`no cell for ${iso}`);
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	}

	test('the first tap places a lone bound with NO band, and says where it is waiting', async ({
		page
	}) => {
		await openSheet(page);
		const month = await visibleMonth(page);

		await page.locator(`[data-bits-day][data-value="${month}-10"]`).tap();

		// A lone bound, and NOTHING in between: a band drawn now would claim a range that does not
		// exist yet. This is the assertion 6L is really about.
		await expect(page.locator('[data-bits-day][data-selection-start]')).toHaveCount(1);
		await expect(page.locator('[data-bits-day][data-range-middle]')).toHaveCount(0);
		await expect(page.locator('[data-bits-day][data-selection-end]')).toHaveCount(0);

		// Four-corner radius, because it is a point and not the left half of a segment.
		const radii = await page.locator('[data-bits-day][data-selection-start]').evaluate((el) => {
			const s = getComputedStyle(el);
			return [
				s.borderTopLeftRadius,
				s.borderTopRightRadius,
				s.borderBottomRightRadius,
				s.borderBottomLeftRadius
			];
		});
		expect(new Set(radii).size).toBe(1);
		expect(radii[0]).toBe('14px');

		// The panel says where it waits, in words — with no hover there is nothing else to say it.
		await expect(page.getByTestId('rc-status')).toContainText('Choisissez la fin');
	});

	test('the second tap draws the band in one change', async ({ page }) => {
		await openSheet(page);
		const month = await visibleMonth(page);

		await page.locator(`[data-bits-day][data-value="${month}-10"]`).tap();
		await page.locator(`[data-bits-day][data-value="${month}-18"]`).tap();

		await expect(page.locator('[data-bits-day][data-selection-start]')).toHaveCount(1);
		await expect(page.locator('[data-bits-day][data-selection-end]')).toHaveCount(1);
		// 11..17 inclusive.
		await expect(page.locator('[data-bits-day][data-range-middle]')).toHaveCount(7);
		await expect(page.getByRole('textbox', { name: 'Du', exact: true })).toHaveValue(/10\//);
		await expect(page.getByRole('textbox', { name: 'Au', exact: true })).toHaveValue(/18\//);
	});

	test('a DRAG across the grid scrolls the sheet and never selects', async ({ page }) => {
		await openSheet(page);
		const month = await visibleMonth(page);

		const scroller = page.locator('[role="dialog"] .overflow-y-auto');
		const before = await scroller.evaluate((el) => el.scrollTop);

		const from = await cellPoint(page, `${month}-24`);
		const to = await cellPoint(page, `${month}-03`);

		// Real touch stream: down on a day, several moves upward across other days, up on a different
		// day. If any of this selected, the grid would be impossible to scroll past on a phone.
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchStart',
			touchPoints: [{ x: from.x, y: from.y }]
		});
		for (let step = 1; step <= 6; step += 1) {
			const y = from.y + ((to.y - from.y) * step) / 6;
			await cdp.send('Input.dispatchTouchEvent', {
				type: 'touchMove',
				touchPoints: [{ x: from.x, y }]
			});
			await page.waitForTimeout(16);
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await page.waitForTimeout(150);

		// Nothing selected — not a bound, not a band.
		await expect(page.locator('[data-bits-day][data-selection-start]')).toHaveCount(0);
		await expect(page.locator('[data-bits-day][data-range-middle]')).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Du', exact: true })).toHaveValue('');

		// ...and the gesture did what it is supposed to do instead.
		const after = await scroller.evaluate((el) => el.scrollTop);
		expect(after).toBeGreaterThan(before);
	});

	test('a long press adds nothing a tap does not already do, and opens no context menu', async ({
		page
	}) => {
		/**
		 * 6L says "appui long : rien", and the reading matters. Taken literally — the press must be
		 * swallowed — this FAILS: a touchstart and touchend at the same point is a tap as far as the
		 * browser is concerned, so it fires a click and places the bound, measured here at 900ms.
		 *
		 * Read with its own two clarifying sentences ("aucun menu contextuel sur une cellule, aucun
		 * geste caché") it passes, and that reading is the one implemented: what the design forbids is
		 * a long press doing something EXTRA or DIFFERENT. Suppressing the click would mean adding a
		 * timing-sensitive gesture layer on top of the cell — which is itself a hidden gesture, and
		 * would break switch control and assistive touch, both of which synthesise long presses.
		 *
		 * Recorded as a divergence rather than settled unilaterally: if the literal reading is meant,
		 * it is a product decision and this test is where it changes.
		 */
		await openSheet(page);
		const month = await visibleMonth(page);
		const point = await cellPoint(page, `${month}-12`);

		let contextMenus = 0;
		await page.exposeFunction('__ctx', () => {
			contextMenus += 1;
		});
		await page.evaluate(() =>
			document.addEventListener('contextmenu', () =>
				(window as unknown as { __ctx: () => void }).__ctx()
			)
		);

		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchStart',
			touchPoints: [{ x: point.x, y: point.y }]
		});
		await page.waitForTimeout(900);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await page.waitForTimeout(150);

		// No context menu, and no SECOND bound: the outcome is exactly a tap's, nothing more.
		expect(contextMenus).toBe(0);
		await expect(page.locator('[data-bits-day][data-selection-start]')).toHaveCount(1);
		await expect(page.locator('[data-bits-day][data-selection-end]')).toHaveCount(0);
		await expect(page.locator('[data-bits-day][data-range-middle]')).toHaveCount(0);
	});

	test('no candidate preview is ever painted on touch', async ({ page }) => {
		await openSheet(page);
		const month = await visibleMonth(page);
		await page.locator(`[data-bits-day][data-value="${month}-10"]`).tap();

		// bits-ui still tracks a highlighted range internally; what 6L forbids is PAINTING it, because
		// a band following the last tap reads as a selection already placed. The root withholds
		// `data-candidate` at this size, so the dashed rules never match.
		const root = page.locator('.rc-root');
		await expect(root).not.toHaveAttribute('data-candidate', /.*/);

		const dashed = await page
			.locator('[data-bits-day]')
			.evaluateAll(
				(els) => els.filter((el) => getComputedStyle(el).borderTopStyle === 'dashed').length
			);
		expect(dashed).toBe(0);
	});
});
