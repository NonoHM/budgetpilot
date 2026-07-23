import { expect, test } from './fixtures';
import { SEEDED_NET_WORTH_ACCOUNT_NAME } from './seed';
import * as m from '../src/lib/paraglide/messages';

// Wave 3 of the component repository migration: /net-worth's mobile account list now
// wraps each account in the shared ListCard. Edit stays always visible; delete
// (destructive) moves behind ListCard's tap-to-expand details slot, mirroring the
// /budgets migration. The expand toggle carries the per-row accessible name
// (expandAriaLabel) while staying visually generic ("···"); the revealed drawer is a
// single tappable "Supprimer" row that opens the confirm dialog directly on tap — not a
// separate icon requiring a second aim (a UX bug fixed once already, don't reintroduce a
// two-tap-to-delete flow here). Savings goals are out of scope (already their own
// tap-to-open GoalStatusCard + TapLink pattern, uniform across breakpoints — no
// ListCard-expand step at all, so no equivalent bug there). Targets the seeded
// "Livret e2e" account (see e2e/seed.ts).
test.describe('net-worth mobile ListCard', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('edit action is visible without expanding; delete is behind the expand toggle', async ({
		page
	}) => {
		await page.goto('/net-worth');

		const editButton = page
			.getByRole('button', { name: m.net_worth_edit_aria({ name: SEEDED_NET_WORTH_ACCOUNT_NAME }) })
			.first();
		await expect(editButton).toBeVisible();

		const expandToggle = page
			.getByRole('button', {
				name: m.net_worth_delete_expand_aria({ name: SEEDED_NET_WORTH_ACCOUNT_NAME })
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
				name: m.net_worth_delete_confirm_title({ name: SEEDED_NET_WORTH_ACCOUNT_NAME })
			})
		).toBeVisible();
	});
});
