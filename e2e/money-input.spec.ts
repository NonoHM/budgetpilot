import { expect, test } from './fixtures';
import { SEEDED_BUDGET_CATEGORY, SEEDED_SAVINGS_GOAL_NAME } from './seed';
import * as m from '../src/lib/paraglide/messages';

// Covers the 4 forms migrated to the shared MoneyInput component (budgets, dashboard manual
// entry, net-worth, savings goals): each amount field keeps its € suffix / label / server-side
// validation flow intact. At least one submitted-zero-on-a-field-that-refuses-it case (budgets
// edit) proves the existing server error is still rendered correctly next to the field.
//
// Money fields are targeted via `input[name="..."]` rather than getByLabel: several of these
// forms have a sibling field whose hint text happens to contain the money field's own label as a
// substring (e.g. net-worth's "as of date" hint mentions "solde"), and MoneyInput's <label> wraps
// a euro-suffix <span> alongside the <input> — both defeat getByLabel's exact-name matching. The
// `name` attribute is already the single source of truth for these fields (form submission).

test('editing the seeded budget to a zero amount shows the existing server-side error', async ({
	page
}) => {
	await page.goto('/budgets');

	await page
		.getByRole('button', { name: m.budgets_edit_aria({ name: SEEDED_BUDGET_CATEGORY }) })
		.click();

	const dialog = page.getByRole('dialog', { name: m.budgets_modal_update_title() });
	await expect(dialog).toBeVisible();

	const amountInput = dialog.locator('input[name="amount"]');
	await expect(amountInput).toBeVisible();
	await amountInput.fill('0');

	await dialog.getByRole('button', { name: m.budgets_submit_update() }).click();

	await expect(dialog.getByText(m.budgets_error_invalid_amount())).toBeVisible();
	// The modal must stay open on a rejected submission (no navigation away, no silent success).
	await expect(dialog).toBeVisible();
});

test('the budgets amount field renders the € suffix, right-aligned, with a 44px touch target', async ({
	page
}) => {
	await page.goto('/budgets');

	await page
		.getByRole('button', { name: m.budgets_edit_aria({ name: SEEDED_BUDGET_CATEGORY }) })
		.click();
	const dialog = page.getByRole('dialog', { name: m.budgets_modal_update_title() });
	const amountInput = dialog.locator('input[name="amount"]');

	await expect(dialog.getByText('€')).toBeVisible(); // currency suffix, not an i18n key
	const box = await amountInput.boundingBox();
	expect(box?.height).toBeGreaterThanOrEqual(44);
});

test('creating a manual transaction on the dashboard accepts a negative amount', async ({
	page
}) => {
	await page.goto('/');

	await page.getByRole('button', { name: m.dashboard_manual_entry(), exact: true }).click();

	const dialog = page.getByRole('dialog', { name: m.dashboard_manual_modal_title() });
	await expect(dialog).toBeVisible();

	// Date field is left at its default (today) so the new transaction lands in the
	// dashboard's default "this month" period and shows up in the recent transactions list.
	await dialog.getByLabel(m.dashboard_field_label()).fill('E2E MoneyInput dashboard');
	await dialog.locator('input[name="amount"]').fill('-12,34');
	// Bits UI's Combobox only opens its option list on real keystrokes, not on a
	// programmatic .fill() (which dispatches a single 'input' event) — pressSequentially
	// simulates actual typing so the dropdown opens and the option becomes clickable.
	const categoryInput = dialog.getByLabel(m.budgets_field_category());
	await categoryInput.click();
	await categoryInput.pressSequentially(SEEDED_BUDGET_CATEGORY, { delay: 20 });
	await page.getByRole('option', { name: SEEDED_BUDGET_CATEGORY, exact: true }).click();

	await dialog.getByRole('button', { name: m.dashboard_submit_add() }).click();

	await expect(page.getByText('E2E MoneyInput dashboard')).toBeVisible();
});

test('creating a net-worth account accepts a zero balance', async ({ page }) => {
	await page.goto('/net-worth');

	await page.getByRole('button', { name: m.net_worth_new() }).click();

	const dialog = page.getByRole('dialog', { name: m.net_worth_modal_create_title() });
	await expect(dialog).toBeVisible();

	await dialog.getByLabel(m.net_worth_field_name()).fill('E2E zero balance account');
	await dialog.locator('input[name="balance"]').fill('0');

	await dialog.getByRole('button', { name: m.common_save() }).click();

	// /net-worth renders the account list twice in the DOM (mobile ListCard + desktop grid,
	// toggled via `lg:hidden`/`hidden lg:grid`) — an unscoped getByText matches both regardless
	// of which is actually visible at the default (desktop) viewport, so scope to the visible one.
	const desktopAccounts = page.locator('div.hidden.lg\\:grid');
	await expect(desktopAccounts.getByText('E2E zero balance account')).toBeVisible();
});

test('creating a net-worth account accepts a negative balance (e.g. a debt)', async ({ page }) => {
	await page.goto('/net-worth');

	await page.getByRole('button', { name: m.net_worth_new() }).click();

	const dialog = page.getByRole('dialog', { name: m.net_worth_modal_create_title() });
	await expect(dialog).toBeVisible();

	await dialog.getByLabel(m.net_worth_field_name()).fill('E2E negative balance account');
	await dialog.locator('input[name="balance"]').fill('-500');

	await dialog.getByRole('button', { name: m.common_save() }).click();

	const desktopAccounts = page.locator('div.hidden.lg\\:grid');
	await expect(desktopAccounts.getByText('E2E negative balance account')).toBeVisible();
});

test('creating a savings goal with a zero target amount is rejected by the existing server validation', async ({
	page
}) => {
	await page.goto('/net-worth');

	await page.getByRole('button', { name: m.savings_goals_new(), exact: true }).click();

	const dialog = page.getByRole('dialog', { name: m.savings_goal_modal_create_title() });
	await expect(dialog).toBeVisible();

	await dialog.getByLabel(m.savings_goal_form_name_label()).fill('E2E invalid target goal');
	await dialog.locator('input[name="targetAmount"]').fill('0');

	await dialog.getByRole('button', { name: m.savings_goal_submit_create() }).click();

	await expect(dialog).toBeVisible();
	await expect(dialog.getByText(m.savings_goal_error_invalid_target())).toBeVisible();
});

test('the seeded savings goal current amount can be edited to another valid value', async ({
	page
}) => {
	await page.goto('/net-worth');

	await page.getByRole('button', { name: SEEDED_SAVINGS_GOAL_NAME }).click();

	const detailDialog = page.getByRole('dialog', { name: SEEDED_SAVINGS_GOAL_NAME });
	await expect(detailDialog).toBeVisible();
	await detailDialog.getByRole('button', { name: m.savings_goal_edit() }).click();

	const editDialog = page.getByRole('dialog', { name: m.savings_goal_modal_update_title() });
	await expect(editDialog).toBeVisible();

	const currentAmountInput = editDialog.locator('input[name="currentAmount"]');
	await expect(currentAmountInput).toBeVisible();
	await currentAmountInput.fill('6000');

	await editDialog.getByRole('button', { name: m.savings_goal_submit_update() }).click();

	await expect(editDialog).not.toBeVisible();
});
