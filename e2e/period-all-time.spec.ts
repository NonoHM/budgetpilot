import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

// "Toujours" (all-time) period option, shared by the dashboard and /reports.
// The budget summary must stay unavailable (it only exists for a whole calendar month),
// exactly like any non-whole-month period — no special casing, just the existing
// isWholeMonthPeriod guard covering the new key.

test('dashboard: choosing the all-time preset reloads all-time and keeps the budget summary unavailable', async ({
	page
}) => {
	await page.goto('/');

	// #547 replaced the period Select with the Periode panel /transactions mounts. Both breakpoint
	// chromes are in the DOM at every width, so this scopes to the visible one rather than taking
	// the first match, which is the hidden mobile trigger.
	const trigger = page
		.getByTestId('period-trigger-group')
		.locator('visible=true')
		.locator('button')
		.first();
	await trigger.click();
	await page.getByRole('button', { name: m.reports_period_all_time(), exact: true }).click();
	await page.getByRole('button', { name: m.transactions_period_apply() }).click();

	await expect(page).toHaveURL(/period=all-time/);
	// The URL must NOT carry a from/to pair beside the key: a named period serialises as its key
	// alone, which is what keeps it a period rather than a frozen range in a bookmark.
	await expect(page).not.toHaveURL(/from=/);
	// Budget tracking card must show the "whole month only" notice, never a budget summary.
	await expect(page.getByText(m.dashboard_budget_unavailable())).toBeVisible();
});

test('reports: all-time renders the period report with the "Toujours" label', async ({ page }) => {
	await page.goto('/reports?period=all-time');

	await expect(page.getByRole('heading', { name: m.reports_heading(), level: 1 })).toBeVisible();
	// The visible chrome's period trigger names the period it is on. Its accessible name carries the
	// unabridged range, so this matches the dimension prefix rather than the whole string.
	await expect(
		page.getByTestId('period-trigger-group').locator('visible=true').first()
	).toContainText(m.reports_period_label());
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
