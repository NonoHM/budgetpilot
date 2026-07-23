import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

// Global skip-link (see +layout.svelte): visually hidden until keyboard-focused, first
// focusable element on every authenticated page. Verifies the exact requirement from the
// dashboard V2 refonte: Tab right after page load must reveal it first, and activating it
// must move focus into the main content region (skipping the header/nav entirely).
test('Tab on page load reveals the skip link first, and activating it focuses main content', async ({
	page
}) => {
	await page.goto('/');

	const skipLink = page.getByRole('link', { name: m.skip_to_main_content() });

	await page.keyboard.press('Tab');
	await expect(skipLink).toBeFocused();

	await page.keyboard.press('Enter');
	await expect(page.locator('#main-content')).toBeFocused();
});
