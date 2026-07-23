import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

// Smoke test #2: basic navigation through AppNav.svelte's desktop nav (aria-label "Navigation
// principale" — distinguishes it from the mobile pill nav, which renders the same links a
// second time in the DOM, hidden via CSS at this viewport size).
test('clicking a nav link navigates to the target page', async ({ page }) => {
	await page.goto('/');

	const mainNav = page.getByRole('navigation', { name: m.nav_aria_main() });
	await mainNav.getByRole('link', { name: m.nav_transactions() }).click();

	await expect(page).toHaveURL(/\/transactions$/);
	await expect(page.getByRole('heading', { level: 1 })).toContainText(m.nav_transactions());
});
