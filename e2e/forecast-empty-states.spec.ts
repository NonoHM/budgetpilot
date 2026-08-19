import { expect, test } from './fixtures';
import { SEEDED_BUDGET_CATEGORY } from './seed';
import type { Page } from '@playwright/test';
import * as m from '../src/lib/paraglide/messages';

// Covers the cash-flow forecast's 3 states end to end (dashboard + /reports, desktop + mobile):
// no detection at all, tentative-only (2 occurrences, never confirmed), and a reliable confirmed
// flow (>=3 occurrences, high/medium confidence) driving the chart + colored KPI + confidence
// badge. Escalates within THIS SINGLE FILE (empty -> tentative -> confirmed) on purpose: the
// forecast's "no confirmed flow" gating is account-wide, and this suite shares one long-lived
// SQLite DB across every spec file within a run (workers: 1, playwright.config.ts) — once
// reports-forecast.spec.ts runs, it permanently seeds a confirmed recurring flow that would make
// any *other* file's "empty state" assertion false for the rest of the run. This file's name
// sorts alphabetically before "reports-forecast.spec.ts" so its empty-state checks below observe
// a clean slate before that happens.
//
// Deliberately NOT `test.describe.configure({ mode: 'serial' })`: serial mode retries the WHOLE
// group from its first test on any failure (Playwright's documented behavior), which — combined
// with the createForecastTransaction() calls below leaving permanent server-side rows — would
// make a retry of a later test re-run the "empty state" tests against a DB that already has the
// confirmed flow from before the failure, breaking their precondition. Plain declaration-order
// execution (guaranteed here since the whole suite runs on a single worker) gives the same
// ordering without that retry pitfall: a failing test retries alone, against unchanged state.

const LABEL = 'E2E FORECAST STATES SUB';

function isoDaysAgo(days: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString().slice(0, 10);
}

async function createForecastTransaction(
	page: Page,
	daysAgo: number,
	amount: string
): Promise<void> {
	await page.goto('/');
	await page.getByRole('button', { name: m.dashboard_manual_entry(), exact: true }).click();
	const dialog = page.getByRole('dialog', { name: m.dashboard_manual_modal_title() });
	await expect(dialog).toBeVisible();

	await dialog.locator('input[name="date"]').fill(isoDaysAgo(daysAgo));
	await dialog.getByLabel(m.dashboard_field_label()).fill(LABEL);
	await dialog.locator('input[name="amount"]').fill(amount);
	const categoryInput = dialog.getByLabel(m.budgets_field_category());
	await categoryInput.click();
	await categoryInput.pressSequentially(SEEDED_BUDGET_CATEGORY, { delay: 20 });
	await page.getByRole('option', { name: SEEDED_BUDGET_CATEGORY, exact: true }).click();

	await dialog.getByRole('button', { name: m.dashboard_submit_add() }).click();
	await expect(dialog).toBeHidden();
}

test.describe('Cash-flow forecast — state 1: no detection at all (desktop)', () => {
	test('dashboard shows the empty state and offers no dead anchor (#202)', async ({ page }) => {
		await page.goto('/');

		await expect(page.getByText(m.dashboard_forecast_empty_title())).toBeVisible();
		// The CTA this used to assert pointed at `/reports#annexe-recurrences`, which renders only
		// when that page's annexe table has rows — a list unrelated to the detector this state comes
		// from. The empty state offered one action and it did nothing. Asserted at the seam that
		// matters, the rendered DOM of a real page, not just in the component spec.
		await expect(page.locator('a[href="/reports#annexe-recurrences"]')).toHaveCount(0);
	});

	test('/reports shows the empty state and offers no dead anchor (#202)', async ({ page }) => {
		// last-90-days (not the this-month default): the seeded base transactions are dated
		// 2026-06-05/12 (e2e/seed.ts) — /reports' own !hasData empty state (unrelated to the
		// forecast) would otherwise hide this whole section if the selected period has zero
		// transactions. The forecast itself is independent of this period selector (CLAUDE.md).
		await page.goto('/reports?period=last-90-days');

		await expect(page.getByRole('heading', { name: m.reports_forecast_heading() })).toBeVisible();
		await expect(page.getByText(m.reports_forecast_empty_title())).toBeVisible();
		await expect(page.locator('a[href="#annexe-recurrences"]')).toHaveCount(0);
	});
});

test.describe('Cash-flow forecast — state 2: tentative only, 2 occurrences (desktop)', () => {
	test('two regular occurrences stay in the empty state (status stays "tentative", never confirmed under 3)', async ({
		page
	}) => {
		await createForecastTransaction(page, 30, '-15,00');
		await createForecastTransaction(page, 0, '-15,00');

		await page.goto('/');
		await expect(page.getByText(m.dashboard_forecast_empty_title())).toBeVisible();

		await page.goto('/reports');
		await expect(page.getByText(m.reports_forecast_empty_title())).toBeVisible();
	});
});

test.describe('Cash-flow forecast — state 3: confirmed reliable flow (desktop)', () => {
	test('dashboard shows the chart and the colored delta/estimated-balance KPI once a 3rd occurrence confirms the flow', async ({
		page
	}) => {
		// Extends the pair seeded above to 3 evenly-spaced (30-day interval, identical amount)
		// occurrences -> status 'confirmed', regularity score high enough for 'high' confidence.
		await createForecastTransaction(page, 60, '-15,00');

		await page.goto('/');
		await expect(page.getByRole('heading', { name: m.dashboard_forecast_title() })).toBeVisible();
		await expect(page.getByText(m.dashboard_forecast_kpi_delta_suffix())).toBeVisible();
		await expect(
			page.getByText(new RegExp(m.dashboard_forecast_kpi_balance_label({ date: '' })))
		).toBeVisible();
	});

	test('/reports shows the chart and the confidence badge in the included-flows table', async ({
		page
	}) => {
		await page.goto('/reports');

		await expect(page.getByRole('heading', { name: m.reports_forecast_heading() })).toBeVisible();
		await expect(page.getByText(m.reports_forecast_chart_title({ months: 3 }))).toBeVisible();
		// 'haute' (reports_confidence_high, messages/fr.json) — the app's actual confidence label,
		// distinct from the design planche's own wording ("Élevée"). Scoping to the flows table
		// specifically (not just any table) avoids matching the same word inside another table on
		// the page (top categories, recurring payments annex, ...).
		const flowsTable = page.locator('table').filter({
			has: page.getByRole('columnheader', { name: m.reports_forecast_table_confidence() })
		});
		await expect(flowsTable.getByText(m.reports_confidence_high())).toBeVisible();
	});
});

test.describe('Cash-flow forecast — state 3: confirmed reliable flow (mobile)', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('dashboard renders the KPI/chart on mobile', async ({ page }) => {
		await page.goto('/');

		await expect(page.getByText(m.dashboard_forecast_kpi_delta_suffix())).toBeVisible();
		await expect(
			page.getByText(new RegExp(m.dashboard_forecast_kpi_balance_label({ date: '' })))
		).toBeVisible();
	});

	test('/reports renders the chart on mobile', async ({ page }) => {
		await page.goto('/reports');

		await expect(page.getByRole('heading', { name: m.reports_forecast_heading() })).toBeVisible();
		await expect(page.getByText(m.reports_forecast_chart_title({ months: 3 }))).toBeVisible();
	});
});
