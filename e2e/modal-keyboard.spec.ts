import { expect, test } from './fixtures';
import {
	SEEDED_BUDGET_CATEGORY,
	SEEDED_NET_WORTH_ACCOUNT_NAME,
	SEEDED_SAVINGS_GOAL_NAME
} from './seed';
import * as m from '../src/lib/paraglide/messages';

// Covers the Modal close-button → IconButton migration (wave 2, see CLAUDE.md): the close
// affordance changed (raw <button> → IconButton) but the focus trap / Escape / focus-restore
// mechanics must be untouched. Drives real keyboard interaction across 5 of the ~30 Modal/
// ConfirmDialog sites — this is the "manual keyboard walkthrough" the migration explicitly
// calls for, automated so it's repeatable instead of a one-off manual pass. None of these tests
// actually confirm a destructive action (no delete is submitted) — only Escape is used to close,
// so the shared seeded dataset used by every other spec stays intact.

test('budgets edit modal: Escape closes and returns focus to the trigger', async ({ page }) => {
	await page.goto('/budgets');
	const trigger = page.getByRole('button', {
		name: m.budgets_edit_aria({ name: SEEDED_BUDGET_CATEGORY })
	});
	await trigger.click();

	const dialog = page.getByRole('dialog', { name: m.budgets_modal_update_title() });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('button', { name: m.common_close() })).toBeVisible();

	await page.keyboard.press('Escape');

	await expect(dialog).not.toBeVisible();
	await expect(trigger).toBeFocused();
});

test('savings goal detail modal (net worth page): close IconButton has an accessible name and Escape closes it', async ({
	page
}) => {
	// The dashboard's own savings-goal card is a non-interactive summary (no onclick, see
	// src/routes/+page.svelte) — the detail modal only opens from /net-worth's
	// SavingsGoalsSection.
	await page.goto('/net-worth');
	const trigger = page.getByRole('button', { name: new RegExp(SEEDED_SAVINGS_GOAL_NAME) });
	await trigger.click();

	const dialog = page.getByRole('dialog', { name: SEEDED_SAVINGS_GOAL_NAME });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('button', { name: m.common_close() })).toBeVisible();

	await page.keyboard.press('Escape');

	await expect(dialog).not.toBeVisible();
});

test('settings restore-backup ConfirmDialog: trigger opens it, Escape closes it, focus returns', async ({
	page
}) => {
	await page.goto('/settings');

	// The restore section is collapsed by default (an irreversible action) — expand it first.
	// Same toggle label is reused by the account-deletion danger zone further down, so scope to
	// the first occurrence (restore comes before deletion on the page).
	await page.getByRole('button', { name: m.settings_toggle_show() }).first().click();

	// The restore button stays disabled until a file is chosen — the dialog only needs to open
	// for this keyboard test, so a minimal in-page file is enough to enable it.
	await page.setInputFiles('input[name="backupFile"]', {
		name: 'backup.json',
		mimeType: 'application/json',
		buffer: Buffer.from('{}')
	});
	const trigger = page.getByRole('button', { name: m.settings_restore_submit() }).first();
	await trigger.click();

	const dialog = page.getByRole('dialog', { name: m.settings_restore_confirm_title() });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('button', { name: m.common_close() })).toBeVisible();

	await page.keyboard.press('Escape');

	await expect(dialog).not.toBeVisible();
	await expect(trigger).toBeFocused();
});

test('rules delete ConfirmDialog: Tab cycles within the dialog, Escape closes it', async ({
	page
}) => {
	await page.goto('/rules');
	const trigger = page.getByRole('button', { name: m.common_delete() }).first();
	await trigger.click();

	const dialog = page.getByRole('dialog', { name: m.rules_delete_confirm_title() });
	await expect(dialog).toBeVisible();

	const closeButton = dialog.getByRole('button', { name: m.common_close() });
	await expect(closeButton).toBeVisible();

	// Focus starts on the first focusable element inside the dialog (the close button).
	await expect(closeButton).toBeFocused();

	await page.keyboard.press('Escape');

	await expect(dialog).not.toBeVisible();
	await expect(trigger).toBeFocused();
});

test('categories delete ConfirmDialog: Escape closes it and returns focus to the trigger', async ({
	page
}) => {
	await page.goto('/categories');
	const trigger = page.getByRole('button', { name: m.common_delete() }).first();
	await trigger.click();

	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('button', { name: m.common_close() })).toBeVisible();

	await page.keyboard.press('Escape');

	await expect(dialog).not.toBeVisible();
	await expect(trigger).toBeFocused();
});

test('net-worth delete ConfirmDialog: Escape closes it and returns focus to the trigger', async ({
	page
}) => {
	await page.goto('/net-worth');
	const trigger = page.getByRole('button', {
		name: m.net_worth_delete_aria({ name: SEEDED_NET_WORTH_ACCOUNT_NAME })
	});
	await trigger.click();

	const dialog = page.getByRole('dialog', {
		name: m.net_worth_delete_confirm_title({ name: SEEDED_NET_WORTH_ACCOUNT_NAME })
	});
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('button', { name: m.common_close() })).toBeVisible();

	await page.keyboard.press('Escape');

	await expect(dialog).not.toBeVisible();
	await expect(trigger).toBeFocused();
});
