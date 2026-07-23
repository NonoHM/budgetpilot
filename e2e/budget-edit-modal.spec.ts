import { expect, test } from './fixtures';
import { SEEDED_BUDGET_CATEGORY } from './seed';
import * as m from '../src/lib/paraglide/messages';

// Smoke test #3: proves the infra can drive an already-migrated component (IconButton) and
// assert on a real UI reaction (Modal opening) — a first proof point for the upcoming
// Modal/Dropdown migration chantier, not just plain navigation. Targets the seeded "Alimentation"
// budget (see e2e/seed.ts, SEEDED_BUDGET_CATEGORY).
test('clicking the edit IconButton on a seeded budget opens the edit modal', async ({ page }) => {
	await page.goto('/budgets');

	await page
		.getByRole('button', { name: m.budgets_edit_aria({ name: SEEDED_BUDGET_CATEGORY }) })
		.click();

	const dialog = page.getByRole('dialog', { name: m.budgets_modal_update_title() });
	await expect(dialog).toBeVisible();
});
