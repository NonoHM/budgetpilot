import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

// EmptyState.svelte migration (see CLAUDE.md "EmptyState" chantier): covers the 3 shapes the
// shared component supports, exercised through real seeded/filtered views rather than a genuinely
// empty account (the shared e2e seed always has 2 categorized transactions, 1 budget, 1 net worth
// account, 1 savings goal — see e2e/seed.ts — so a truly empty account is out of scope for this
// shared seed; see CLAUDE.md for the documented trade-off).
//
// The /transactions empty state only exists in the mobile layout today (pre-existing behavior,
// not introduced by this migration — the desktop table has no dedicated "no results" message) —
// these two specs force a mobile viewport to exercise it.
test.describe('transactions empty states (mobile layout)', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the "to classify" tab shows the simple no-CTA empty state once everything is categorized', async ({
		page
	}) => {
		// Both seeded transactions already carry a category (see e2e/seed.ts), so the "classify"
		// tab is empty by construction — no seed mutation needed.
		await page.goto('/transactions?type=classify');

		await expect(page.getByText(m.transactions_empty_all_classified_title())).toBeVisible();
	});

	test('a search with no match shows the empty state with a reset-filters action', async ({
		page
	}) => {
		await page.goto('/transactions');

		const searchInput = page.locator('input[name="q"]:visible');
		await searchInput.fill('ce libellé ne correspond à aucune transaction seedée');
		await searchInput.press('Enter');

		await expect(page.getByText(m.transactions_empty_no_results_title())).toBeVisible();
		await expect(
			page.getByRole('link', { name: m.transactions_reset_filters_link() })
		).toBeVisible();
	});
});

test('reports on a date range with no transactions shows the empty state with the 2-button action', async ({
	page
}) => {
	// A custom range far before any seeded transaction: same shape as a genuinely empty account,
	// without touching the shared seed.
	await page.goto('/reports?period=custom&from=2000-01-01&to=2000-01-02');

	await expect(page.getByText(m.reports_empty_heading())).toBeVisible();
	await expect(page.getByRole('link', { name: m.reports_empty_import_cta() })).toBeVisible();
	await expect(
		page.getByRole('button', { name: m.reports_empty_change_period_cta() })
	).toBeVisible();
});
