// The filter bar's geometry, in the only place it exists: a real page at a real viewport.
//
// Every claim here failed a component test's reach for the same reason — each one is about several
// components AGREEING with each other on one row, or about the document as a whole. A component
// spec can prove SearchBar renders 34px; only the page can prove it renders 34px beside three
// triggers that also do.
import { expect, test } from './fixtures';

test.describe('/transactions — the desktop filter bar at 1280', () => {
	test('every control on the row is the same height, and the controls inside the field clear 24px', async ({
		page
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto('/transactions');

		const measured = await page.evaluate(() => {
			const form = document.querySelector('form[method="GET"].flex.flex-wrap');
			if (!form) return null;
			const controls = Array.from(form.children)
				.map((child) => {
					const box = child.getBoundingClientRect();
					return {
						label: (child.textContent || '').trim().slice(0, 20) || child.tagName,
						height: Math.round(box.height)
					};
				})
				.filter((c) => c.height > 0);

			const toggle = Array.from(form.querySelectorAll('button')).find(
				(b) => (b.textContent || '').trim() === '.*'
			);
			const toggleBox = toggle?.getBoundingClientRect();
			return {
				controls,
				toggle: toggleBox
					? { width: Math.round(toggleBox.width), height: Math.round(toggleBox.height) }
					: null
			};
		});

		expect(measured, 'the desktop filter form was not found').not.toBeNull();
		// Four controls, not three: an empty list would satisfy "all heights equal" trivially, which
		// is the shape of an assertion that cannot fail.
		expect(measured!.controls.length).toBeGreaterThanOrEqual(4);

		const heights = [...new Set(measured!.controls.map((c) => c.height))];
		expect(
			heights,
			`filter-bar controls disagree about their height: ${JSON.stringify(measured!.controls)}`
		).toEqual([34]);

		// The regex toggle lives INSIDE the search field, so shrinking the field is exactly what
		// could push it under the minimum target without anything else moving.
		expect(measured!.toggle, 'the regex toggle was not found in the filter bar').not.toBeNull();
		expect(measured!.toggle!.width).toBeGreaterThanOrEqual(24);
		expect(measured!.toggle!.height).toBeGreaterThanOrEqual(24);
		expect(measured!.toggle!.height).toBeLessThanOrEqual(34);
	});

	test('the open Période panel keeps its content inside its own border', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto('/transactions');

		await page.getByRole('button', { name: 'Période', exact: true }).first().click();
		const panel = page.getByRole('dialog').first();
		await expect(panel).toBeVisible();

		const overflow = await panel.evaluate((node) => {
			const right = node.getBoundingClientRect().right;
			let widest = 0;
			let worst = '';
			node.querySelectorAll('*').forEach((child) => {
				const box = child.getBoundingClientRect();
				if (box.width > 0 && box.right > widest) {
					widest = box.right;
					worst = (child.textContent || child.tagName).trim().slice(0, 30);
				}
			});
			return {
				scrollWidth: node.scrollWidth,
				clientWidth: node.clientWidth,
				overhang: Math.round(widest - right),
				worst
			};
		});

		// It shipped at scrollWidth 338 against clientWidth 278, with `Appliquer` painted 58px past
		// the right border. Nothing clipped it and nothing was red.
		expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
		expect(overflow.overhang, `"${overflow.worst}" hangs outside the panel`).toBeLessThanOrEqual(0);
	});
});

test.describe('/transactions — 390', () => {
	test('nothing makes the page scroll sideways with a filter active', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		// A filter must be active: the reset link and the bulk trigger — the pair that overflowed —
		// are rendered only then. Without the query this test passes against the broken build.
		await page.goto('/transactions?q=a');
		// `:visible`, not `.first()`: /transactions mounts the desktop and mobile surfaces at once and
		// only hides one with CSS, so the first match here is the hidden desktop copy.
		await expect(page.locator('[data-testid=bulk-tag-trigger]:visible')).toBeVisible();

		const doc = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth
		}));

		expect(doc.clientWidth).toBe(390);
		// 457 against 390 before the fix: the bulk trigger's label is a whole sentence, it was made
		// `w-full` inside a flex row that also held the reset link, and no ancestor clipped it.
		expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);
	});
});
