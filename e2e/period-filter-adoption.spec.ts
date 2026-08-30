import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

/**
 * #547. The dashboard and /reports mount the same Periode panel /transactions does, with their own
 * preset set passed as a prop.
 *
 * What only an end-to-end test can see, and the reason the page specs point here: the URL the panel
 * navigates to, and whether the server then agrees it is the period the reader asked for. The unit
 * tests pin `periodQueryOfRange` as a pure function and pin it against the server's own serialiser,
 * and neither of them can tell you that the panel is wired to it.
 */

/**
 * The visible chrome's period trigger. Both breakpoint trees are in the DOM at every width, so a
 * bare locator returns the hidden one and every click waits for ever on it.
 */
function periodTrigger(page: import('@playwright/test').Page) {
	return page.getByTestId('period-trigger-group').locator('visible=true').locator('button').first();
}

for (const route of ['/', '/reports'] as const) {
	test(`${route}: a preset applies under its own period key, with no from or to beside it`, async ({
		page
	}) => {
		await page.goto(route);
		await periodTrigger(page).click();
		// The label the PANEL renders, which is `transactions_period_preset_last_month`. The Select
		// this replaced used `reports_period_last_month`, a different string for the same period
		// ("Mois dernier" against "Le mois dernier"): naming the wrong one here is a test that waits
		// thirty seconds for a button that was never going to exist.
		await page
			.getByRole('button', { name: m.transactions_period_preset_last_month(), exact: true })
			.click();
		await page.getByRole('button', { name: m.transactions_period_apply() }).click();

		// Separates "a named period keeps its name" from "it is flattened to a custom range". The
		// second renders the same figures for the same days and silently drops comparisonMonth,
		// which is derived from the KEY and only for this-month and last-month.
		await expect(page).toHaveURL(/[?&]period=last-month/);
		await expect(page).not.toHaveURL(/[?&]from=/);
		await expect(page).not.toHaveURL(/[?&]to=/);
	});

	test(`${route}: a hand-typed range applies as a custom period carrying both bounds`, async ({
		page
	}) => {
		await page.goto(route);
		await periodTrigger(page).click();

		await page.getByLabel(m.reports_from_label(), { exact: true }).fill('03/03/2026');
		await page.getByLabel(m.reports_to_label(), { exact: true }).fill('12/06/2026');
		await page.getByRole('button', { name: m.transactions_period_apply() }).click();

		// The counterpart of the test above, and the half that proves the key is not simply hardcoded:
		// a range that is no preset must carry its ISO bounds, never a bare period=custom, which is
		// the shape that renders the error page (#548).
		await expect(page).toHaveURL(/[?&]period=custom/);
		await expect(page).toHaveURL(/[?&]from=2026-03-03/);
		await expect(page).toHaveURL(/[?&]to=2026-06-12/);
	});

	test(`${route}: the panel carries a calendar, which is the defect #547 closes`, async ({
		page
	}) => {
		await page.goto(route);

		// Before #547 these two routes had two text date boxes and no grid anywhere. The byte length
		// is printed beside the count so a page that failed to render cannot report as a page with no
		// calendar: those are the same zero otherwise.
		const before = (await page.content()).length;
		expect(before, 'the route did not render').toBeGreaterThan(1000);
		await expect(page.locator('[role="grid"]')).toHaveCount(0);

		await periodTrigger(page).click();

		await expect(page.locator('[role="grid"]').locator('visible=true')).toHaveCount(1);
		expect((await page.content()).length).toBeGreaterThan(before);
	});
}

test('/reports: the empty-state CTA opens the period panel', async ({ page }) => {
	// This CTA used to be `form="period-form-mobile"` with `type="submit"`, which resubmitted the
	// period form. #547 removed that form, so without a rewire the button would be inert: a dead
	// control that looks identical to a live one, and nothing else in this suite touches it.
	//
	// Separates "the CTA does what its label says" from "the CTA does nothing", which is exactly the
	// pair that a form-attribute pointing at a deleted id produces.
	await page.goto('/reports?period=custom&from=1990-01-01&to=1990-01-31');

	await expect(page.locator('[role="grid"]')).toHaveCount(0);
	await page.getByRole('button', { name: m.reports_empty_change_period_cta() }).click();

	await expect(page.locator('[role="grid"]').locator('visible=true')).toHaveCount(1);
});

/**
 * THE ARRIVAL DEFAULT: what period a route shows when it is entered having chosen nothing.
 *
 * Nothing asserted this before. `date-range.spec.ts` pins that `parseDateRange` returns this-month
 * for empty params, and both page specs hardcode `key: 'this-month'` in their FIXTURES, which
 * assumes the answer rather than checking it. Neither can see a route that arrives somewhere else.
 *
 * It is the one property a preset swap can break in silence. The panel is handed `from`/`to` and
 * could, through an effect or an armed default, navigate on mount and impose a period of its own:
 * the reader's first screen would show a different period than yesterday, every figure on it would
 * be correct for that period, and nothing on the page would say the period had changed.
 *
 * So both halves are asserted, and the first is the one that matters: the URL must still be bare.
 * A route that resolves this-month AFTER rewriting itself to `?period=this-month` has already
 * proved it can rewrite itself, and the next default it invents will not be the same one.
 */
for (const route of ['/', '/reports'] as const) {
	test(`${route}: arriving with no parameter stays on this-month and leaves the URL alone`, async ({
		page
	}) => {
		await page.goto(route);
		await page.waitForLoadState('networkidle');

		// Separates "the route kept the server's default" from "the control navigated on mount".
		expect(new URL(page.url()).search, 'the control rewrote the URL on arrival').toBe('');

		// Separates "the period in effect is this-month" from "it is something else the panel armed".
		// Read off the panel's own armed row, which is what the reader sees, rather than off a label
		// that would still read correctly for a period nobody chose.
		await periodTrigger(page).click();
		expect(
			await page
				.getByRole('button', { name: m.transactions_period_preset_this_month(), exact: true })
				.locator('visible=true')
				.first()
				.getAttribute('aria-pressed')
		).toBe('true');
	});
}

test('/transactions: arriving with no parameter applies no period filter at all', async ({
	page
}) => {
	// The third arrival state, and it is a DIFFERENT one: /transactions has no period model and no
	// default period, so its Periode dimension must come up at rest. Included here because the
	// inventory in #547 turns on these three routes not sharing one answer, and an assertion that
	// only covered the two reporting screens would let a future change give this one a default
	// without anything noticing.
	await page.goto('/transactions');
	await page.waitForLoadState('networkidle');

	expect(new URL(page.url()).search).toBe('');
	// At rest the trigger carries the dimension name alone and renders no clear button. A period
	// silently applied here would show a value beside it.
	const group = page.getByTestId('period-trigger-group').locator('visible=true').first();
	expect((await group.innerText()).trim()).toBe(m.transactions_filter_dimension_period());
	await expect(group.locator('button')).toHaveCount(1);
});
