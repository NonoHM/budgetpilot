import { expect, test } from './fixtures';

// Keyboard contract of BottomSheet (mobile transaction detail sheet), added with
// the shared $lib/focus.ts extraction: the sheet carries aria-modal="true", so
// Tab must cycle inside it (never escape to the page behind), Escape must close
// it, and focus must return to the row that opened it. Mirrors Modal's existing
// keyboard coverage (modal-keyboard.spec.ts) for the other overlay family.

// BottomSheet is mobile-only (the whole layer is lg:hidden) — pin a phone-sized
// viewport so the sheet, not the desktop detail panel, is the visible surface.
test.use({ viewport: { width: 390, height: 844 } });

const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

test('BottomSheet traps Tab both ways, closes on Escape and restores focus', async ({ page }) => {
	await page.goto('/transactions');

	const row = page.getByRole('link', { name: /CARREFOUR MARKET/ }).first();
	await row.click();

	const sheet = page.getByRole('dialog', { name: /CARREFOUR MARKET/ });
	await expect(sheet).toBeVisible();

	// Initial focus moves into the sheet (focusFirst on open).
	await expect.poll(() => sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);

	// Forward Tab: walk one full cycle past the number of focusable elements —
	// focus must stay inside the sheet at every step, including the wrap-around.
	const focusableCount = await sheet.locator(FOCUSABLE_SELECTOR).count();
	expect(focusableCount).toBeGreaterThan(0);
	for (let i = 0; i < focusableCount + 2; i++) {
		await page.keyboard.press('Tab');
		expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
	}

	// Backward wrap: Shift+Tab from the first element must land on the last, not
	// escape behind the sheet. Focus the first focusable explicitly so the
	// assertion tests the wrap itself, not wherever the loop above stopped.
	await sheet.locator(FOCUSABLE_SELECTOR).first().focus();
	await page.keyboard.press('Shift+Tab');
	expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);

	// Escape closes the sheet and focus returns to the triggering row (the close
	// navigation uses keepFocus + the sheet's focus restore).
	await page.keyboard.press('Escape');
	await expect(sheet).not.toBeVisible();
	await expect(row).toBeFocused();
});
