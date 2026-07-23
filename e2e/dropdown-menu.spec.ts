import { expect, test } from './fixtures';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from './seed';
import * as m from '../src/lib/paraglide/messages';

// Covers the DropdownMenu wrapper extraction (wave 2, see CLAUDE.md): AccountMenu.svelte and
// AppNav.svelte's mobile "More" menu were deduped onto a shared ui/DropdownMenu.svelte wrapper
// around Bits UI's DropdownMenu. Flagged sensitive because AccountMenu's "Déconnexion" item is a
// real <form method="POST" action="/logout"> submission, not a link — these tests drive full
// keyboard interaction (not just mouse) and explicitly prove logout still works via both Enter
// and click after the migration, plus the general ARIA menu contract (arrow-key navigation,
// Escape closes without selecting, focus returns to the trigger).
//
// The seeded e2e account is a plain USER (see e2e/seed.ts) — AccountMenu therefore shows exactly
// 2 items: "Paramètres" then "Déconnexion" (no "Administration").
//
// IMPORTANT: logging out for real revokes the session token server-side (revokeSessionToken in
// src/lib/server/auth.ts), not just a client-side cookie — doing that with the suite's shared
// `storageState` (e2e/.auth/user.json) would permanently kill the authenticated session every
// other spec in the run depends on. The two tests that actually complete a logout therefore log
// in fresh themselves (`test.use({ storageState: undefined })` + a real UI login), so only their
// own throwaway session is revoked.

test.describe('AccountMenu (desktop)', () => {
	test('keyboard: Tab to trigger, Enter opens the menu, arrow keys navigate, Escape closes without navigating and returns focus to the trigger', async ({
		page
	}) => {
		await page.goto('/');

		const trigger = page.getByRole('button', { name: m.account_menu_trigger_aria() });
		await trigger.focus();
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');

		await page.keyboard.press('Enter');
		await expect(trigger).toHaveAttribute('aria-expanded', 'true');

		const menu = page.getByRole('menu');
		await expect(menu).toBeVisible();

		const settingsItem = page.getByRole('menuitem', { name: m.account_menu_settings() });
		const logoutItem = page.getByRole('menuitem', { name: m.account_menu_logout() });
		await expect(settingsItem).toBeFocused();

		await page.keyboard.press('ArrowDown');
		await expect(logoutItem).toBeFocused();

		await page.keyboard.press('ArrowDown');
		await expect(settingsItem).toBeFocused();

		await page.keyboard.press('ArrowUp');
		await expect(logoutItem).toBeFocused();

		await page.keyboard.press('Escape');
		await expect(menu).not.toBeVisible();
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');
		await expect(trigger).toBeFocused();
		// Escape must not have navigated or logged out.
		await expect(page).toHaveURL('/');
	});
});

test.describe('AccountMenu logout (fresh throwaway session per test)', () => {
	// No shared storageState: each test logs itself in via the real UI form, so the logout it
	// performs only revokes its own session, not the suite-wide one.
	test.use({ storageState: { cookies: [], origins: [] } });

	async function loginFresh(page: import('@playwright/test').Page) {
		await page.goto('/login');
		await page.getByLabel(m.login_email_label()).fill(E2E_USER_EMAIL);
		await page
			.getByRole('textbox', { name: m.login_password_label(), exact: false })
			.fill(E2E_USER_PASSWORD);
		await page.getByRole('button', { name: m.login_submit() }).click();
		await expect(page).not.toHaveURL(/\/login/);
	}

	test('keyboard: arrowing down to "Déconnexion" and pressing Enter logs out', async ({ page }) => {
		await loginFresh(page);

		const trigger = page.getByRole('button', { name: m.account_menu_trigger_aria() });
		await trigger.focus();
		await page.keyboard.press('Enter');

		await expect(page.getByRole('menuitem', { name: m.account_menu_settings() })).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(page.getByRole('menuitem', { name: m.account_menu_logout() })).toBeFocused();

		await page.keyboard.press('Enter');

		await expect(page).toHaveURL(/\/login/);
	});

	test('mouse: clicking "Déconnexion" logs out', async ({ page }) => {
		await loginFresh(page);

		await page.getByRole('button', { name: m.account_menu_trigger_aria() }).click();
		await page.getByRole('menuitem', { name: m.account_menu_logout() }).click();

		await expect(page).toHaveURL(/\/login/);
	});
});

test.describe('AppNav "More" menu (mobile)', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('keyboard: opens with Enter, arrow keys navigate the 3 links, Escape closes without navigating', async ({
		page
	}) => {
		await page.goto('/');

		const trigger = page.getByRole('button', { name: m.nav_more_aria() });
		await trigger.focus();
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');

		await page.keyboard.press('Enter');
		await expect(trigger).toHaveAttribute('aria-expanded', 'true');

		const rulesItem = page.getByRole('menuitem', { name: m.nav_rules() });
		const importsItem = page.getByRole('menuitem', { name: m.nav_imports() });
		const netWorthItem = page.getByRole('menuitem', { name: m.nav_net_worth() });

		await expect(rulesItem).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(importsItem).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(netWorthItem).toBeFocused();

		await page.keyboard.press('Escape');
		await expect(page.getByRole('menu')).not.toBeVisible();
		await expect(trigger).toBeFocused();
		await expect(page).toHaveURL('/');
	});

	test('mouse: clicking a link in the More menu navigates there', async ({ page }) => {
		await page.goto('/');

		await page.getByRole('button', { name: m.nav_more_aria() }).click();
		await page.getByRole('menuitem', { name: m.nav_rules() }).click();

		await expect(page).toHaveURL(/\/rules/);
	});
});
