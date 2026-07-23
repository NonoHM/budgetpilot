import { expect, test } from './fixtures';
import { SEEDED_BUDGET_CATEGORY, SEEDED_NET_WORTH_ACCOUNT_NAME } from './seed';
import * as m from '../src/lib/paraglide/messages';

// Covers the AlertBanner standardization (wave 2, see CLAUDE.md): budgets previously had zero
// post-action feedback (silent after every create/update/delete), and budgets/net-worth/imports
// each had a raw <p> error duplicated inside a modal alongside a page-level AlertBanner sharing
// the same form.error key — a real double-announcement risk (two role="alert" regions firing for
// the same message) that the page-level banner is now gated to avoid while the relevant modal is
// open. These tests drive the real app rather than just asserting on markup, per the migration's
// explicit ask to verify the gating concretely.

test('budgets: creating a budget shows the new success feedback', async ({ page }) => {
	await page.goto('/budgets');

	await page.getByRole('button', { name: m.budgets_new() }).first().click();
	const dialog = page.getByRole('dialog', { name: m.budgets_modal_create_title() });
	await expect(dialog).toBeVisible();

	// "Transport" is a seeded default category with no budget yet (only SEEDED_BUDGET_CATEGORY
	// has one from e2e/seed.ts), so this is a genuine create, not a silent upsert-update.
	// Bits UI's Combobox only opens its option list on real keystrokes, not a programmatic
	// .fill() — pressSequentially simulates actual typing (see e2e/money-input.spec.ts).
	const categoryInput = dialog.getByLabel(m.budgets_field_category());
	await categoryInput.click();
	await categoryInput.pressSequentially(m.category_default_transport(), { delay: 20 });
	await page.getByRole('option', { name: m.category_default_transport(), exact: true }).click();
	await dialog.locator('input[name="amount"]').fill('80');
	await dialog.getByRole('button', { name: m.common_save() }).click();

	await expect(dialog).not.toBeVisible();
	await expect(page.getByRole('status')).toContainText(m.budgets_success_created());
});

test('budgets: a validation error inside the edit modal produces exactly one alert region, not two', async ({
	page
}) => {
	await page.goto('/budgets');

	await page
		.getByRole('button', { name: m.budgets_edit_aria({ name: SEEDED_BUDGET_CATEGORY }) })
		.click();
	const dialog = page.getByRole('dialog', { name: m.budgets_modal_update_title() });
	await expect(dialog).toBeVisible();

	await dialog.locator('input[name="amount"]').fill('0');
	await dialog.getByRole('button', { name: m.budgets_submit_update() }).click();

	await expect(dialog.getByText(m.budgets_error_invalid_amount())).toBeVisible();
	// The gating fix's entire point: the page-level banner must stay suppressed while this
	// modal is open, so only the modal's own contextual banner announces the error.
	await expect(page.locator('[role="alert"]')).toHaveCount(1);
	await expect(dialog).toBeVisible();
});

test('net-worth: a validation error inside the edit modal produces exactly one alert region, not two', async ({
	page
}) => {
	await page.goto('/net-worth');

	await page
		.getByRole('button', { name: m.net_worth_edit_aria({ name: SEEDED_NET_WORTH_ACCOUNT_NAME }) })
		.click();
	const dialog = page.getByRole('dialog', { name: m.net_worth_modal_update_title() });
	await expect(dialog).toBeVisible();

	await dialog.locator('input[name="balance"]').fill('not-a-number');
	await dialog.getByRole('button', { name: m.net_worth_submit_update() }).click();

	await expect(dialog.getByText(m.net_worth_error_invalid_balance())).toBeVisible();
	// net-worth already had a page-level AlertBanner for form.error before this migration —
	// the highest-risk case for a newly-introduced double announcement once its 3 modals also
	// gained their own AlertBanner.
	await expect(page.locator('[role="alert"]')).toHaveCount(1);
	await expect(dialog).toBeVisible();
});
