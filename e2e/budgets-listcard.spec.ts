import { expect, test } from './fixtures';
import { SEEDED_BUDGET_CATEGORY } from './seed';
import * as m from '../src/lib/paraglide/messages';

// Wave 3 of the component repository migration: /budgets' mobile list now wraps
// BudgetStatusCard in the shared ListCard. Edit stays always visible (it's the most
// frequent action on this page, not a secondary one) — only delete (destructive) moves
// behind ListCard's tap-to-expand "details" slot. The expand toggle itself carries the
// per-row accessible name (expandAriaLabel) while staying visually generic ("···"); the
// revealed drawer is a single tappable "Supprimer" row that opens the confirm dialog
// directly on tap — not a separate icon requiring a second aim (a UX bug fixed once
// already, don't reintroduce a two-tap-to-delete flow here). Targets the seeded
// "Alimentation" budget (see e2e/seed.ts, SEEDED_BUDGET_CATEGORY).
test.describe('budgets mobile ListCard', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('status badge and edit action are visible without expanding; delete is behind the expand toggle', async ({
		page
	}) => {
		await page.goto('/budgets');

		await expect(page.getByText(SEEDED_BUDGET_CATEGORY).first()).toBeVisible();
		await expect(page.getByText(m.budgets_status_ok(), { exact: true }).first()).toBeVisible();

		const editButton = page
			.getByRole('button', { name: m.budgets_edit_aria({ name: SEEDED_BUDGET_CATEGORY }) })
			.first();
		await expect(editButton).toBeVisible();

		const expandToggle = page
			.getByRole('button', {
				name: m.budgets_delete_expand_aria({ name: SEEDED_BUDGET_CATEGORY })
			})
			.first();
		await expect(expandToggle).toBeVisible();

		const deleteRow = page.getByRole('button', { name: m.common_delete(), exact: true });
		await expect(deleteRow).not.toBeVisible();

		// Single tap on the revealed "Supprimer" row must open the confirm dialog directly —
		// no separate icon to aim for a second time.
		await expandToggle.click();
		await expect(deleteRow).toBeVisible();
		await deleteRow.click();

		await expect(
			page.getByRole('dialog', {
				name: m.budgets_delete_confirm_title({ name: SEEDED_BUDGET_CATEGORY })
			})
		).toBeVisible();
	});
});
