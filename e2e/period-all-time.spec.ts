import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

// "Toujours" (all-time) period option, shared by the dashboard and /reports.
// The budget summary must stay unavailable (it only exists for a whole calendar month),
// exactly like any non-whole-month period — no special casing, just the existing
// isWholeMonthPeriod guard covering the new key.

test('dashboard: selecting "Toujours" reloads all-time and keeps the budget summary unavailable', async ({
	page
}) => {
	await page.goto('/');

	// The period Select is a Bits UI trigger (role button) whose accessible name is its
	// placeholder ("Sélectionner…") — target it by name, then by the displayed period text.
	const periodTrigger = page.getByRole('button', { name: m.common_select_placeholder() });
	await expect(periodTrigger.filter({ hasText: m.reports_period_this_month() })).toBeVisible();
	await periodTrigger.click();
	await page.getByRole('option', { name: m.reports_period_all_time(), exact: true }).click();

	await expect(page).toHaveURL(/period=all-time/);
	await expect(periodTrigger.filter({ hasText: m.reports_period_all_time() })).toBeVisible();
	// Budget tracking card must show the "whole month only" notice, never a budget summary.
	await expect(page.getByText(m.dashboard_budget_unavailable())).toBeVisible();
});

test('reports: all-time renders the period report with the "Toujours" label', async ({ page }) => {
	await page.goto('/reports?period=all-time');

	await expect(page.getByRole('heading', { name: m.reports_heading(), level: 1 })).toBeVisible();
	// Desktop period form only — the mobile twin is display:none and excluded from the a11y tree (role-based locator).
	await expect(
		page
			.getByRole('button', { name: m.reports_period_label() })
			.filter({ hasText: m.reports_period_all_time() })
	).toBeVisible();
	// The report body actually renders (seeded transactions fall inside the all-time range).
	await expect(
		page.getByRole('heading', { name: m.reports_takeaways_heading() }).first()
	).toBeVisible();
});

// The 731-day (24-month) cap on the "custom" period was removed (never a documented perf guard —
// see date-range.ts history; all-time already ships the same unbounded, narrow-select query shape).
// This spans >6 years, well past the old cap, to prove it no longer errors.
test('reports: a custom range spanning more than 2 years no longer errors (731-day cap removed)', async ({
	page
}) => {
	await page.goto('/reports?period=custom&from=2020-01-01&to=2026-07-22');

	await expect(page.getByRole('heading', { name: m.reports_heading(), level: 1 })).toBeVisible();
	await expect(
		page.getByRole('heading', { name: m.reports_takeaways_heading() }).first()
	).toBeVisible();
});
