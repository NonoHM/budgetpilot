import { expect, test } from './fixtures';
import { E2E_USER_EMAIL } from './seed';
import * as m from '../src/lib/paraglide/messages';

// Wave 3 of the component repository migration (page 6/6, closing this chantier): /admin's
// mobile user list now wraps each row in the shared ListCard. Reset password (a meaningful
// but non-destructive admin action) stays always visible; delete account (destructive —
// cascades transactions/categories/budgets) moves behind ListCard's tap-to-expand details
// slot, using expandAriaLabel so each row's toggle has a unique accessible name per email —
// same pattern as /rules, /categories, /imports. The current admin's own row ("Vous-même")
// keeps having no reset/delete/expand at all, matching the system-category treatment on
// /categories (no actions rendered means no ListCard details slot at all).
//
// The invitations list is also wrapped in ListCard for consistent card chrome, but — unlike
// every other list in this migration wave — revoke stays always visible rather than behind
// the expand toggle: an invitation row has exactly one action, and hiding a card's sole
// action behind a tap adds friction with no decluttering benefit (per UX review).
//
// /admin requires ADMIN role, but the suite's shared storageState session is a plain USER
// (deliberate, see e2e/seed.ts's comment on why). This spec logs in fresh as the disposable
// bootstrap admin account instead of using the shared session — that account is real, has
// ADMIN role, is never deleted (self-deletion is blocked), and its credentials are fixed in
// e2e/seed.ts.
test.describe('admin mobile ListCard', () => {
	test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 } });

	test.beforeEach(async ({ page }) => {
		await page.goto('/login');
		await page.getByLabel(m.login_email_label()).fill('e2e-bootstrap-admin@budgetpilot.test');
		await page
			.getByRole('textbox', { name: m.login_password_label(), exact: false })
			.fill('E2eBootstrapAdmin123!');
		await page.getByRole('button', { name: m.login_submit() }).click();
		await expect(page).not.toHaveURL(/\/login/);
	});

	test('reset password is visible without expanding; delete is behind the expand toggle', async ({
		page
	}) => {
		await page.goto('/admin');

		const mobileList = page.locator('section.lg\\:hidden div.space-y-3').first();
		const targetCard = mobileList.locator('> div', { hasText: E2E_USER_EMAIL }).first();

		await expect(targetCard.getByRole('button', { name: m.admin_reset_password() })).toBeVisible();
		await expect(
			targetCard.getByRole('button', { name: m.common_delete(), exact: true })
		).toHaveCount(0);

		const expandToggle = targetCard.getByRole('button', {
			name: m.admin_delete_expand_aria({ email: E2E_USER_EMAIL })
		});
		await expect(expandToggle).toBeVisible();
		await expandToggle.click();

		const deleteButton = targetCard.getByRole('button', { name: m.common_delete(), exact: true });
		await expect(deleteButton).toBeVisible();
		await deleteButton.click();

		await expect(page.getByRole('dialog', { name: m.admin_delete_confirm_title() })).toBeVisible();
	});

	test("the current admin's own row has no expand toggle (no reset/delete available)", async ({
		page
	}) => {
		await page.goto('/admin');

		const mobileList = page.locator('section.lg\\:hidden div.space-y-3').first();
		const selfCard = mobileList.locator('> div', { hasText: m.admin_you() }).first();

		await expect(selfCard.getByText(m.admin_you())).toBeVisible();
		await expect(selfCard.getByRole('button', { name: m.admin_reset_password() })).toHaveCount(0);
		await expect(selfCard.locator('button[aria-expanded]')).toHaveCount(0);
	});

	test('creating an invitation shows it with revoke always visible (no expand toggle)', async ({
		page
	}) => {
		await page.goto('/admin');

		const inviteEmail = 'e2e-listcard-invite@budgetpilot.test';
		const inviteForm = page.locator('form[action="?/createInvitation"]').last();
		await inviteForm.getByLabel(m.admin_invitation_email_label()).fill(inviteEmail);
		await inviteForm.getByRole('button', { name: m.admin_invitation_create() }).click();

		const inviteSection = page.locator('div.space-y-2').last();
		const inviteCard = inviteSection.locator('> div', { hasText: inviteEmail }).first();
		await expect(inviteCard).toBeVisible();

		await expect(
			inviteCard.getByRole('button', { name: m.admin_invitation_revoke(), exact: true })
		).toBeVisible();
		await expect(inviteCard.locator('button[aria-expanded]')).toHaveCount(0);

		await inviteCard
			.getByRole('button', { name: m.admin_invitation_revoke(), exact: true })
			.click();
		await expect(
			page.getByRole('dialog', { name: m.admin_invitation_revoke_confirm_title() })
		).toBeVisible();
	});
});
