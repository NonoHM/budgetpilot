import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

// Extension of the predefined-rules catalog (46 -> 156 entries, see
// src/lib/server/categorization/default-rules/). This spec confirms the extended catalog
// renders correctly on both breakpoints (desktop table + mobile ListCard, both present in
// the DOM per the app's CSS-only responsive pattern) and captures a render-time budget so a
// future further extension has a baseline to compare against — not a strict pass/fail gate
// (no prior baseline existed before this catalog size), just a documented measurement.
test.describe('rules default catalog (extended)', () => {
	test('desktop table renders every seeded default rule with the "Prédéfini" badge', async ({
		page
	}) => {
		const start = Date.now();
		await page.goto('/rules');
		const table = page.locator('table');
		await expect(table).toBeVisible();
		const renderMs = Date.now() - start;

		const desktopRows = page.locator('table tbody tr');
		const rowCount = await desktopRows.count();
		// The e2e account only ever gets the seeded defaults (no custom rules created by other
		// specs run before this one touch /rules), so this should equal the full catalog size.
		expect(rowCount).toBeGreaterThanOrEqual(150);

		await expect(page.getByText(m.rules_badge_default()).first()).toBeVisible();

		console.log(`[perf] /rules desktop table (${rowCount} rows) visible after ${renderMs}ms`);
	});

	test('label filter stays responsive against the full catalog', async ({ page }) => {
		await page.goto('/rules');
		await expect(page.locator('table')).toBeVisible();

		// Two SearchBar instances exist in the DOM at any viewport (desktop #search-rules +
		// mobile #search-rules-mobile, CSS-only toggle) — scope to the desktop one explicitly,
		// an unscoped getByPlaceholder would hit both and throw a strict-mode violation.
		const searchStart = Date.now();
		await page.locator('#search-rules').fill('netflix');
		await expect(page.locator('table tbody tr')).toHaveCount(1);
		const searchMs = Date.now() - searchStart;

		console.log(`[perf] /rules label filter narrowed to 1 row after ${searchMs}ms`);
		expect(searchMs).toBeLessThan(2000);
	});

	test('mobile ListCard renders the extended catalog', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/rules');

		const mobileList = page.locator('div.lg\\:hidden.space-y-4');
		await expect(mobileList).toBeVisible();
		const cards = mobileList.locator('div.space-y-3 > div');
		await expect(cards.first()).toBeVisible();
		expect(await cards.count()).toBeGreaterThanOrEqual(150);
	});
});
