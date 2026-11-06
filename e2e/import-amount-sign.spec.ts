import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

/**
 * #1207 C2c-S1, from the blind test of 2026-11-06. An unsigned statement on the auto path used to
 * stop on `/import` with three blocks saying one thing: the refusal sentence, an offer to
 * « designate the columns » (which is not the question), and a summary titled « this file could
 * not be read » (it was read). The sign being the one open question, the upload now goes straight
 * to the designation screen, where the question opens on arrival.
 *
 * Separates « straight to the one question » from « stopped on the refusal page »: the URL and the
 * question's heading are asserted together, and the offer's own explanation must not be on screen.
 * Only a browser can see this: the chosen file has to survive the navigation (see
 * `designateColumns` in `src/routes/import/+page.svelte`).
 *
 * Writes nothing: no account is created and no row imported, so later specs sharing the database
 * meet the state they expect.
 */
const UNSIGNED = [
	'date;label;amount',
	'24/06/2026;E2E SIGN CARREFOUR;24,90',
	'22/06/2026;E2E SIGN ORANGE;39,99'
].join('\n');

test.describe('an unsigned statement at 390x844', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('goes straight to the sign question instead of stopping on a refusal', async ({ page }) => {
		await page.goto('/import');
		const form = page.locator('form[method="POST"]:visible').first();
		await form.locator('input[name="csvFile"]').setInputFiles({
			name: 'e2e-unsigned.csv',
			mimeType: 'text/csv',
			buffer: Buffer.from(UNSIGNED, 'utf-8')
		});
		await form.getByRole('button', { name: m.import_submit() }).click();

		await expect(page).toHaveURL(/\/import\/columns$/);
		await expect(
			page.getByRole('heading', { name: m.import_designate_amount_sign_title() })
		).toBeVisible();
		await expect(page.getByText(m.import_columns_offer_explanation())).toHaveCount(0);
	});
});
