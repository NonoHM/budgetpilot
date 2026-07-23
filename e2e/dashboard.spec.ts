import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

// Smoke test #1: proves the storageState fixture actually authenticates every spec — no manual
// login here, the session comes from e2e/.auth/user.json (written by global-setup.ts).
test('authenticated session lands on the dashboard, not /login', async ({ page }) => {
	await page.goto('/');

	await expect(page).not.toHaveURL(/\/login/);
	await expect(page.getByRole('heading', { name: m.nav_dashboard(), level: 1 })).toBeVisible();
});
