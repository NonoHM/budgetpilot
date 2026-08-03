import { expect, test } from './fixtures';
import { SEEDED_SAVINGS_GOAL_NAME, SEEDED_TRANSACTION_LABELS } from './seed';
import * as m from '../src/lib/paraglide/messages';

// Wave 3 follow-up: TapLink v2 (component referential brick 4 — no chevron, no permanent
// underline, `tone` prop) generalized beyond savings goals, plus Avatar's new `size` prop
// (brick 13). Desktop uses the default (>=1024px) viewport; mobile uses a 390x844 viewport,
// matching the rest of the suite's convention for pages that render distinct desktop/mobile
// markup for the same data.

test.describe('TapLink (desktop)', () => {
	test('transactions: "Réinitialiser les filtres" clears an empty-result filter', async ({
		page
	}) => {
		await page.goto('/transactions?q=zzz-no-such-transaction-zzz');

		const desktopPanel = page.locator('div.hidden.lg\\:grid');
		// Scoped to the EMPTY STATE's reset. The summary row carries a second link with the same
		// words and is on screen at the same time whenever a filter returns nothing, so the bare
		// role+name locator is ambiguous — and was, the moment the summary row gained that control.
		const resetLink = desktopPanel
			.locator('[data-testid="empty-reset-filters"]')
			.getByRole('link', { name: m.transactions_reset_filters_link() });
		await expect(resetLink).toBeVisible();

		await resetLink.click();
		await expect(page).toHaveURL(/\/transactions$/);
		await expect(desktopPanel.getByText(SEEDED_TRANSACTION_LABELS[0])).toBeVisible();
	});

	test('transactions: "Gérer les catégories" in the detail panel navigates to /categories', async ({
		page
	}) => {
		await page.goto('/transactions');

		const desktopPanel = page.locator('div.hidden.lg\\:grid');
		await desktopPanel
			.getByRole('link', { name: new RegExp(SEEDED_TRANSACTION_LABELS[0]) })
			.click();

		await desktopPanel.getByRole('link', { name: m.transactions_manage_categories_link() }).click();

		await expect(page).toHaveURL(/\/categories/);
	});

	test('net-worth: SavingsGoalForm "Ajouter une échéance" reveals the deadline field', async ({
		page
	}) => {
		await page.goto('/net-worth');

		await page.getByRole('button', { name: m.savings_goals_new(), exact: true }).click();
		const dialog = page.getByRole('dialog', { name: m.savings_goal_modal_create_title() });
		await expect(dialog).toBeVisible();

		await expect(dialog.getByLabel(m.savings_goal_form_deadline_label())).not.toBeVisible();
		await dialog.getByRole('button', { name: m.savings_goal_form_add_deadline() }).click();
		await expect(dialog.getByLabel(m.savings_goal_form_deadline_label())).toBeVisible();
	});

	test('net-worth: SavingsGoalDetailModal "Supprimer" (tone danger) opens the delete confirm dialog', async ({
		page
	}) => {
		await page.goto('/net-worth');

		await page.getByRole('button', { name: new RegExp(SEEDED_SAVINGS_GOAL_NAME) }).click();
		const detailDialog = page.getByRole('dialog', { name: SEEDED_SAVINGS_GOAL_NAME });
		await expect(detailDialog).toBeVisible();

		await detailDialog.getByRole('button', { name: m.savings_goal_delete(), exact: true }).click();

		await expect(
			page.getByRole('dialog', {
				name: m.savings_goal_delete_confirm_title({ name: SEEDED_SAVINGS_GOAL_NAME })
			})
		).toBeVisible();
	});
});

test.describe('TapLink (mobile)', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('transactions: mobile "Réinitialiser les filtres" clears an empty-result filter', async ({
		page
	}) => {
		await page.goto('/transactions?q=zzz-no-such-transaction-zzz');

		// Several `.lg:hidden` containers exist on this page (filters card, tabs, list) — scope to
		// the list one via its always-present pagination controls (unlike the reset link/results,
		// which come and go, so the locator stays valid across the reset navigation below).
		const mobileList = page
			.locator('div.lg\\:hidden')
			.filter({ hasText: m.transactions_previous() });
		// See the desktop case: the summary row's reset carries the same accessible name.
		const resetLink = mobileList
			.locator('[data-testid="empty-reset-filters"]')
			.getByRole('link', { name: m.transactions_reset_filters_link() });
		await expect(resetLink).toBeVisible();

		await resetLink.click();
		await expect(page).toHaveURL(/\/transactions$/);
		await expect(mobileList.getByText(SEEDED_TRANSACTION_LABELS[0])).toBeVisible();
	});

	test('transactions: mobile "Gérer les catégories" navigates to /categories', async ({ page }) => {
		await page.goto('/transactions');

		const mobileList = page
			.locator('div.lg\\:hidden')
			.filter({ hasText: m.transactions_previous() });
		await mobileList.getByRole('link', { name: new RegExp(SEEDED_TRANSACTION_LABELS[0]) }).click();

		const sheet = page.getByRole('dialog', { name: SEEDED_TRANSACTION_LABELS[0] });
		await expect(sheet).toBeVisible();
		await sheet.getByRole('link', { name: m.transactions_manage_categories_link() }).click();

		await expect(page).toHaveURL(/\/categories/);
	});
});

test.describe('Avatar size prop', () => {
	test('desktop: dashboard recent-transactions avatar uses the 32px "liste" size', async ({
		page
	}) => {
		// Unlike /transactions (avatars only in the mobile ListCard), the dashboard's recent
		// transactions row markup is shared between breakpoints — a single instance to check.
		// The dashboard defaults to "this month"; the seeded transactions are dated 2026-06,
		// so a custom period covering that month is required for them to show up here.
		await page.goto('/?period=custom&from=2026-06-01&to=2026-06-30');

		const avatar = page.getByText('CM', { exact: true });
		await expect(avatar).toBeVisible();
		await expect(avatar).toHaveClass(/h-8/);
		await expect(avatar).toHaveClass(/w-8/);
	});

	test('mobile: transactions list avatar uses the 32px "liste" size', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/transactions');

		const mobileList = page
			.locator('div.lg\\:hidden')
			.filter({ hasText: SEEDED_TRANSACTION_LABELS[0] });
		const avatar = mobileList.getByText('CM', { exact: true });
		await expect(avatar).toBeVisible();
		await expect(avatar).toHaveClass(/h-8/);
		await expect(avatar).toHaveClass(/w-8/);
	});

	test('AccountMenu avatar keeps the 36px "navbar" size', async ({ page }) => {
		await page.goto('/');

		const trigger = page.getByRole('button', { name: m.account_menu_trigger_aria() });
		const avatar = trigger.locator('div[aria-hidden="true"]');
		await expect(avatar).toHaveClass(/h-9/);
		await expect(avatar).toHaveClass(/w-9/);
	});
});
