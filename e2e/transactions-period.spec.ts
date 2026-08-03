// The Période claims that only a real browser can settle. Everything here is a rendered pixel, a
// tooltip that must open without a mouse, or a format that must not depend on the browser's locale —
// none of which a unit fixture can assert, and the last of which is the defect this dimension closes.
import { expect, test } from './fixtures';
import { E2E_LOCALE } from './config';

const RANGES = [
	{ from: '2026-03-03', to: '2026-06-12', what: 'same-year range' },
	{ from: '2026-09-30', to: '2027-02-28', what: 'cross-year, long months' },
	{ from: '2024-01-01', to: '2026-12-31', what: 'whole-year multi-year span' },
	{ from: '2026-09-30', to: '', what: 'open start' },
	{ from: '', to: '2027-02-28', what: 'open end' },
	{ from: '2026-12-24', to: '2027-01-03', what: 'cross-year, short span' }
];

test.describe('/transactions — Période', () => {
	test('every rung honours the 190px cap in a real rendering', async ({ page }) => {
		for (const range of RANGES) {
			await page.goto(`/transactions?from=${range.from}&to=${range.to}`);
			const value = page.getByTestId('period-value').first();
			const box = await value.boundingBox();
			expect(box, `${range.what} rendered no value at all`).not.toBeNull();
			// The cap is enforced by the LADDER, not by CSS overflow: Période is exempt from the bar's
			// ellipsis convention, so an overflow here would be visible rather than clipped.
			expect(box!.width, `${range.what} (${range.from}..${range.to})`).toBeLessThanOrEqual(190);
		}
	});

	test('the rendered dates do not depend on the browser locale', async ({ browser }) => {
		// THE DEFECT. `type="date"` follows the BROWSER's locale and ignores every `lang` attribute
		// the app can set, so one build showed jj/mm/aaaa on one machine and mm/dd/yyyy on another.
		// The app's own locale is pinned by cookie in both contexts below; only the browser's locale
		// differs, and the rendered value must therefore be identical.
		const rendered: string[] = [];
		for (const locale of ['fr-FR', 'en-US']) {
			const context = await browser.newContext({ locale });
			await context.addCookies([
				{ name: 'PARAGLIDE_LOCALE', value: E2E_LOCALE, url: 'http://localhost:4174' }
			]);
			const page = await context.newPage();
			await page.goto('/transactions?from=2026-03-03&to=2026-06-12');
			rendered.push((await page.getByTestId('period-value').first().innerText()).trim());
			await context.close();
		}
		// Asserted equal AND non-empty: two empty strings are also equal, and that is the shape of a
		// test that cannot fail.
		expect(rendered[0].length).toBeGreaterThan(0);
		expect(rendered[0]).toBe(rendered[1]);
	});

	test('a shortened value opens its tooltip on keyboard focus, not only on hover', async ({
		page
	}) => {
		// `title` would satisfy a mouse user and leave the sighted keyboard user with no way to read
		// the unabridged form. This is why the design specifies the Tooltip brick instead.
		await page.goto('/transactions?from=2026-09-30&to=2027-02-28');
		const trigger = page.getByRole('button', { name: /Période/ }).first();
		await trigger.focus();
		await expect(page.getByRole('tooltip')).toContainText('30 septembre 2026');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('tooltip')).toHaveCount(0);
	});

	test('the value carries the unabridged form as its accessible name', async ({ page }) => {
		await page.goto('/transactions?from=2026-09-30&to=2027-02-28');
		await expect(
			page.getByRole('button', { name: /30 septembre 2026 → 28 février 2027/ }).first()
		).toBeVisible();
	});
});
