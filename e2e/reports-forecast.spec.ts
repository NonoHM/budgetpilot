import { expect, test } from './fixtures';
import { SEEDED_BUDGET_CATEGORY } from './seed';
import * as m from '../src/lib/paraglide/messages';

// Regression guard for the "Solde projeté (N mois)" label on /reports: N must come from
// FORECAST_REPORTS_HORIZON_MONTHS (derived from server/forecast/index.ts's
// FORECAST_REPORTS_HORIZON_DAYS), never a hardcoded "3 mois" string — a prior version of this
// label was written in dur and would silently desync if the horizon constant ever changed.
// Confirms the forecast section actually renders (needs >=3 occurrences of the same
// direction/label/category/amount to become a "confirmed" recurring flow, see
// domain/forecast.ts's detectRecurringFlows) and shows the current 3-month horizon.
test('reports forecast chart title reflects the current horizon, not a hardcoded value', async ({
	page
}) => {
	const label = 'E2E FORECAST SUBSCRIPTION';
	const today = new Date();
	const isoDaysAgo = (days: number) => {
		const d = new Date(today);
		d.setUTCDate(d.getUTCDate() - days);
		return d.toISOString().slice(0, 10);
	};

	await page.goto('/');

	for (const daysAgo of [60, 30, 0]) {
		await page.getByRole('button', { name: m.dashboard_manual_entry(), exact: true }).click();
		const dialog = page.getByRole('dialog', { name: m.dashboard_manual_modal_title() });
		await expect(dialog).toBeVisible();

		await dialog.locator('input[name="date"]').fill(isoDaysAgo(daysAgo));
		await dialog.getByLabel(m.dashboard_field_label()).fill(label);
		await dialog.locator('input[name="amount"]').fill('-9,99');
		const categoryInput = dialog.getByLabel(m.budgets_field_category());
		await categoryInput.click();
		await categoryInput.pressSequentially(SEEDED_BUDGET_CATEGORY, { delay: 20 });
		await page.getByRole('option', { name: SEEDED_BUDGET_CATEGORY, exact: true }).click();

		await dialog.getByRole('button', { name: m.dashboard_submit_add() }).click();
		await expect(dialog).toBeHidden();
	}

	await page.goto('/reports');

	await expect(page.getByRole('heading', { name: m.reports_forecast_heading() })).toBeVisible();
	await expect(page.getByText(m.reports_forecast_chart_title({ months: 3 }))).toBeVisible();
});
