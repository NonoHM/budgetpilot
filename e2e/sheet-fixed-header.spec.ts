import { expect, test } from './fixtures';
import { expectFixedHeader } from './sheet-header';

/**
 * THE WHOLE-ARTIFACT HALF OF THE FIXED-HEADER LAW.
 *
 * `BottomSheet.svelte.spec.ts` proves the COMPONENT pins whatever it is handed, and `header` being a
 * required prop proves every call site hands it something. Neither proves the something is the
 * title: a call site can satisfy the type with an empty snippet and leave its `<h2>` at the top of
 * the scrolling body, which is exactly the state four of these five sheets were in before
 * 2026-08-07. That is the per-leg blindness the first standing principle is about — each part green,
 * the combination unasserted — so it is asserted here, on the real pages, in a real browser.
 *
 * Measured while writing it, at 390x844, on how far each title used to travel out of view on the way
 * down: transaction detail **247 px**, category sub-sheet **165 px**. The Filtres sheet held still
 * only because its body was 174 px of content and never scrolled at all — an accident of how many
 * filters exist today, not a property, which is why it is asserted too.
 *
 * The /upcoming-bills action sheet is covered by the same helper from `upcoming-bills.spec.ts`,
 * where its fixture is already seeded — see the note in `sheet-header.ts` for why it is not here.
 */

test.use({ viewport: { width: 390, height: 844 } });

test('every mobile sheet on /transactions renders its title in the fixed header', async ({
	page
}) => {
	await page.goto('/transactions');
	await page
		.getByRole('link', { name: /CARREFOUR MARKET/ })
		.first()
		.click();
	await expect(page.getByRole('dialog', { name: /CARREFOUR MARKET/ })).toBeVisible();
	await expectFixedHeader(page, /CARREFOUR MARKET/);
	await page.keyboard.press('Escape');

	await page.getByRole('button', { name: 'Filtres', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'Filtres' })).toBeVisible();
	await expectFixedHeader(page, /Filtres/);

	await page.getByRole('dialog', { name: 'Filtres' }).getByText('Catégorie').first().click();
	await expect(page.getByRole('dialog', { name: 'Catégorie' })).toBeVisible();
	await expectFixedHeader(page, /Catégorie/);
	await page.keyboard.press('Escape');

	// The Période sheet is the ONE call site that already obeyed the law, and its geometry is
	// byte-identical before and after making `header` required (809 / 28 / 57 / 607 / 117, measured).
	// Asserted here so it stays the control rather than becoming an untested assumption.
	await page.goto('/transactions');
	await page
		.getByRole('button', { name: /Période/ })
		.first()
		.click();
	await expect(page.getByRole('dialog', { name: /Période/ })).toBeVisible();
	await expectFixedHeader(page, /Période/);
});
