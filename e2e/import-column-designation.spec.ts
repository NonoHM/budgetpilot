import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

/**
 * The three layers, end to end: a file nothing recognises, designated, imported, and then
 * recognised on its own the second time.
 *
 * ## The second upload is the only proof that layer three exists
 *
 * The first half of this spec proves the SCREEN works, which the component specs already assert
 * more cheaply. The second half is what nothing else can reach: re-uploading the same file and
 * finding that the designation screen **does not open** and the import goes straight through.
 *
 * That crosses every layer in one gesture. The fingerprint has to be computed from the same bytes
 * twice, the mapping has to have been written under the right owner, the lookup has to find it by
 * shape, `applyColumnMapping` has to resolve the roles against the file's real headers, and the
 * parser has to run through the mapped path. A unit test can assert each of those and still leave
 * the chain broken between any two of them.
 *
 * Ruling A1 is the behaviour under test: the screen does not open for a known file. Its accepted
 * cost is that the user never re-sees what was memorised, which is what the recapitulatif exists to
 * mitigate, and which is asserted at the component level rather than here.
 *
 * ## The file is deliberately unlike anything the alias table knows
 *
 * `Jour`, `Intitule operation` and `Somme` are real spellings a French bank uses and the alias
 * table does not carry. If a later PR widens the alias table to include them, THIS SPEC IS THE ONE
 * THAT SHOULD GO RED, because the first upload would then be recognised and the designation screen
 * would never open. That is a true finding about the widening, not a broken test: it means the file
 * chosen to be unrecognisable stopped being so.
 */
/**
 * **390x844, and the viewport is part of the test rather than a convenience.**
 *
 * The suite runs `Desktop Chrome` by default. The picker is a `BottomSheet`, and that component is
 * `lg:hidden` by construction: the referential's answer at desktop is an anchored Dropdown, not a
 * sheet, so the sheet makes itself inert above 1024 rather than rendering in the wrong place.
 *
 * The consequence is a real gap and it is filed rather than worked around here: **at 1280 the four
 * role rows are triggers that open nothing.** Neither the component specs nor the desktop geometry
 * spec could see it, because both assert that the four buttons EXIST and neither opens one. This
 * e2e is the level where a trigger and the thing it triggers are in the same test.
 *
 * So the flow is exercised at the width it was designed and measured at, and the desktop picker is
 * its own issue.
 */
test.use({ viewport: { width: 390, height: 844 } });

const UNRECOGNISED_CSV = [
	'Jour;Intitule operation;Somme',
	'24/06/2026;E2E DESIGNATION CARREFOUR;-24,90',
	'21/06/2026;E2E DESIGNATION SALAIRE;1850,00'
].join('\n');

/**
 * Text that is actually ON SCREEN, not merely in the document.
 *
 * Every page in this application renders a desktop and a mobile layout and hides one with CSS, so a
 * bare `getByText(...).first()` resolves to whichever copy comes first in the DOM, which at 390 is
 * the hidden one. The failure then reads « the text is missing » while the text is present and
 * correct, and the real cause is the assertion, not the page. Three assertions in this file were
 * written that way and all three failed on a working flow before this helper existed.
 */
function onScreen(page: import('@playwright/test').Page, text: string) {
	return page.getByText(text).filter({ visible: true }).first();
}

async function uploadUnrecognised(page: import('@playwright/test').Page) {
	await page.goto('/import');
	// `:visible`, not `.first()`. Both layouts render their own copy of this form and CSS hides one;
	// `.first()` is the DESKTOP copy, which at 390 is the hidden one, and every interaction with it
	// times out in a way that reads like a missing element rather than like the wrong element.
	const form = page.locator('form[method="POST"]:visible').first();
	await form.locator('input[name="csvFile"]').setInputFiles({
		name: 'e2e-designation.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(UNRECOGNISED_CSV, 'utf-8')
	});
	await form.getByRole('button', { name: m.import_submit() }).click();
	return form;
}

test('an unrecognised file is offered the designation screen rather than only refused', async ({
	page
}) => {
	// The two states this separates: a refusal that states the problem, and a refusal that offers
	// the repair. Before this chantier the user was told their columns were not recognised and left
	// there. The offer is the whole feature, and it must appear on the SAME response as the refusal
	// rather than after another upload.
	const form = await uploadUnrecognised(page);

	// Scoped to the VISIBLE form for the same reason the upload is: the hidden desktop copy carries
	// the identical text, so an unscoped `.first()` resolves to an element that exists and can never
	// be visible, and the failure reads as "the offer is missing" when the offer is fine.
	await expect(form.getByText(m.import_columns_offer_explanation())).toBeVisible();
});

test('designating three columns imports the file with the right signs', async ({ page }) => {
	const form = await uploadUnrecognised(page);
	await form.getByRole('button', { name: m.import_columns_offer() }).click();

	await expect(page).toHaveURL(/\/import\/columns$/);
	await expect(page.getByRole('heading', { name: m.import_columns_page_title() })).toBeVisible();

	// One picker per required role. The rows are chosen by their accessible name, which is what a
	// screen reader hears, so a row whose visible text was right and whose name was wrong would
	// fail here rather than pass.
	for (const [rowName, column] of [
		[/^Date, aucune colonne désignée/, /^Jour\./],
		[/^Libellé, aucune colonne désignée/, /^Intitule operation\./],
		[/^Montant, aucune colonne désignée/, /^Somme\./]
	] as const) {
		await page.getByRole('button', { name: rowName }).click();
		await page.getByRole('option', { name: column }).click();
	}

	await page.getByRole('button', { name: /^Importer/ }).click();
	await expect(page).toHaveURL(/\/import$/, { timeout: 15_000 });

	// The SIGNS are the assertion, not merely that rows landed. Every measured defect in this
	// chantier that reached money was a sign defect: a statement of magnitudes beside a direction
	// column imports as all-income, and a mapping that reads the wrong column reads the date as an
	// amount. A row count would pass on all of those.
	await page.goto('/transactions');
	await expect(onScreen(page, 'E2E DESIGNATION CARREFOUR')).toBeVisible();
	await expect(onScreen(page, 'E2E DESIGNATION SALAIRE')).toBeVisible();
	await expect(onScreen(page, '-24,90')).toBeVisible();
	await expect(onScreen(page, '1 850,00')).toBeVisible();
});

test('the same file imports straight through the second time, without the screen opening', async ({
	page
}) => {
	// LAYER THREE, and the only end-to-end proof of it. Depends on the previous test having
	// designated and imported: this suite runs `workers: 1` in declaration order and specs share one
	// database, which is what makes a second upload meaningful at all.
	const form = await uploadUnrecognised(page);

	// The offer must be ABSENT, and its absence is asserted against a presence established by the
	// first test in this file: the same locator, scoped the same way, found it there, so not finding
	// it here is a fact about the mapping rather than about the selector.
	await expect(form.getByText(m.import_columns_offer_explanation())).toHaveCount(0);
	await expect(page).toHaveURL(/\/import$/);

	// And the import really ran rather than merely not being refused. The file is a duplicate of
	// the one already imported, so the rows are recognised as duplicates: that IS the mapped path
	// running, because a file the parser could not read would have produced invalid rows instead.
	await expect(onScreen(page, m.import_summary_heading())).toBeVisible();
});
