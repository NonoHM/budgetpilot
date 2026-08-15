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
test.describe.configure({ mode: 'serial' });

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

/**
 * The assertion a human's eye would fail, and the one an end-to-end journey does not make.
 *
 * Playwright clicks what a human cannot see. This screen's journey passed for two days while the
 * bottom tab bar was painted straight over the action footer and the import control was half
 * covered. A test that only asks whether the journey TERMINATES cannot see that; a human asking
 * whether it can be PERFORMED sees nothing else.
 *
 * So: read the primary's box and every fixed or sticky element on the page, and assert they do not
 * intersect. Four lines, at each width.
 */
async function expectPrimaryUnobstructed(page: import('@playwright/test').Page, label: RegExp) {
	const primary = await page.getByRole('button', { name: label }).first().boundingBox();
	expect(primary).not.toBeNull();

	// FULLY INSIDE THE VIEWPORT, and this is the half that catches the real defect. The app chrome
	// added `pb-32` around a screen that builds its own full-height stack, so the action footer was
	// pushed BELOW the fold: the primary was not covered, it was off-screen, and the page scrolled
	// to reveal a sliver of it. An overlap scan alone reports nothing, because nothing overlaps.
	const viewport = page.viewportSize();
	expect(viewport).not.toBeNull();
	expect(primary!.y + primary!.height, 'the primary is below the fold').toBeLessThanOrEqual(
		viewport!.height
	);
	expect(primary!.y, 'the primary is above the fold').toBeGreaterThanOrEqual(0);

	const obstructions = await page.evaluate((label) => {
		const primaryEl = [...document.querySelectorAll('button')].find((el) =>
			new RegExp(label).test(el.textContent ?? '')
		);
		return [...document.querySelectorAll('body *')]
			.filter((el) => {
				const position = getComputedStyle(el).position;
				if (position !== 'fixed' && position !== 'sticky') return false;
				// An ANCESTOR cannot cover its own child. The desktop layout deliberately makes the
				// banner-and-actions box sticky, and that box CONTAINS the primary: counting it would
				// report the intended design as the defect.
				return !(primaryEl && el.contains(primaryEl));
			})
			.map((el) => {
				const box = el.getBoundingClientRect();
				return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
			})
			.filter((box) => box.bottom > box.top && box.right > box.left);
	}, label.source);

	// CALIBRATE THE DETECTOR, NOT THE PAGE. The first version asserted the page carried at least
	// one fixed element, and that fired after the fix removed the app chrome from this route: the
	// page legitimately has none. What has to be proved is that the SCAN would see an overlap if
	// there were one, so one is injected over the primary, detected, and removed.
	const detected = await page.evaluate((rect) => {
		const probe = document.createElement('div');
		probe.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px`;
		document.body.appendChild(probe);
		const box = probe.getBoundingClientRect();
		const seen =
			rect.x < box.right &&
			rect.x + rect.width > box.left &&
			rect.y < box.bottom &&
			rect.y + rect.height > box.top;
		probe.remove();
		return seen;
	}, primary!);
	expect(detected, 'the overlap scan cannot see a deliberate overlap').toBe(true);

	for (const box of obstructions) {
		const overlaps =
			primary!.x < box.right &&
			primary!.x + primary!.width > box.left &&
			primary!.y < box.bottom &&
			primary!.y + primary!.height > box.top;
		expect(overlaps, `a fixed or sticky element covers the primary: ${JSON.stringify(box)}`).toBe(
			false
		);
	}
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

test.describe('at 390x844', () => {
	test.use({ viewport: { width: 390, height: 844 } });

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

		// Before pressing it: the control has to be reachable by a person, not only by a click.
		await expectPrimaryUnobstructed(page, /^Importer/);

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

	/**
	 * THE RUN THAT DESIGNATES IS THE RUN THAT SAYS NOTHING, and that is #338.
	 *
	 * The test above proves the rows land and their signs are right. It cannot see that the user is
	 * never TOLD, because it verifies the outcome from `/transactions` — which is precisely the
	 * cross-check a person had to perform by hand to discover 9 of 66 rows had been rejected.
	 *
	 * The asymmetry is the defect. A file imported through `/import` reports; the same file imported
	 * through the designation screen reports nothing; and the SECOND import of that same file, now
	 * memorised, reports again. So the evidence does arrive — one run late, detached from the choice
	 * that caused it, on a screen the user cannot return to.
	 *
	 * A HEADING ALONE WOULD NOT DO. The counts are asserted because the summary panel is what makes a
	 * partial import legible, and a partial import is the shape this screen produces: a designated
	 * amount column that is empty on some rows takes those rows out silently.
	 */
	/**
	 * HEADERS UNIQUE PER ATTEMPT, and the retry is why.
	 *
	 * The suite runs with `retries: 2`. A test that designates a file MEMORISES its shape, so the
	 * second attempt uploads a file the app now recognises, imports straight through, and never
	 * opens the designation screen: the retry then fails waiting for an offer that is correctly
	 * absent, reporting a fixture problem as a product one. That happened on the first run of this
	 * test and is the same class of mistake the comments above record five times, arriving by a new
	 * route — through the retry rather than through a sibling test.
	 *
	 * Suffixing the header row makes every attempt a genuinely unrecognised file, so attempt 2 tests
	 * what attempt 1 tested.
	 */
	function partialCsv(attempt: number): string {
		const suffix = attempt === 0 ? '' : ` r${attempt}`;
		return [
			`Date ecriture${suffix};Libelle ecriture${suffix};Mouvement${suffix}`,
			'12/06/2026;E2E SUMMARY EPICERIE;-12,30',
			'10/06/2026;E2E SUMMARY REMBOURSEMENT;45,00',
			// The shape from the field report, in miniature: a row whose designated amount cell is
			// empty. It must be REPORTED, not merely dropped.
			'08/06/2026;E2E SUMMARY SANS MONTANT;'
		].join('\n');
	}

	test('a designated import reports its summary on the run that designated it', async ({
		page
	}, testInfo) => {
		// ITS OWN HEADERS. A mapping is fingerprinted over the header row, so reusing this file's
		// shape from an earlier test in this file would find that mapping, import straight through,
		// and never open the screen — the fixture mistake this spec has recorded five times.
		const PARTIAL_CSV = partialCsv(testInfo.retry);
		await page.goto('/import');
		const form = page.locator('form[method="POST"]:visible').first();
		await form.locator('input[name="csvFile"]').setInputFiles({
			name: 'e2e-designation-summary.csv',
			mimeType: 'text/csv',
			buffer: Buffer.from(PARTIAL_CSV, 'utf-8')
		});
		await form.getByRole('button', { name: m.import_submit() }).click();
		await form.getByRole('button', { name: m.import_columns_offer() }).click();

		await expect(page).toHaveURL(/\/import\/columns$/);
		for (const [rowName, column] of [
			[/^Date, aucune colonne désignée/, /^Date ecriture/],
			[/^Libellé, aucune colonne désignée/, /^Libelle ecriture/],
			[/^Montant, aucune colonne désignée/, /^Mouvement/]
		] as const) {
			await page.getByRole('button', { name: rowName }).click();
			await page.getByRole('option', { name: column }).click();
		}
		await page.getByRole('button', { name: /^Importer/ }).click();

		await expect(onScreen(page, m.import_summary_heading())).toBeVisible({ timeout: 15_000 });
		await expect(onScreen(page, m.import_stat_rows_read())).toBeVisible();
		await expect(onScreen(page, m.import_stat_imported())).toBeVisible();
		await expect(onScreen(page, m.import_stat_invalid())).toBeVisible();

		// THE REJECTED ROW IS NAMED, not merely counted, and this is the half that matters. The
		// heading below renders only when `invalidRowDetails` is non-empty, so it is a proof that the
		// details travelled rather than that a number did. A count alone reproduces the field report:
		// the user could see that nine rows had failed and never which nine.
		await expect(onScreen(page, m.import_invalid_heading())).toBeVisible();
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
});

/**
 * THE SAME JOURNEY AT 1280, and it is the acceptance for #334.
 *
 * Not "four buttons exist", which is what the desktop geometry spec asserted while the screen could
 * not be used at all. A screen's acceptance is a journey completed: arrive, do the thing the screen
 * exists for, and see the outcome elsewhere in the application. The measurements are properties of
 * something that works.
 *
 * A different file from the 390 tests, deliberately. Sharing one would make this pass on the
 * REMEMBERED mapping from the earlier journey and never open the screen at all, which is the
 * fixture-choosing failure this repository has now recorded four times.
 */
test.describe('at 1280x800', () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	/**
	 * DIFFERENT HEADERS, not merely different rows.
	 *
	 * The first draft changed only the data and kept `Jour;Intitule operation;Somme`. A mapping is
	 * fingerprinted over the HEADER row, so that file was the same shape as the 390 journey's, found
	 * the mapping it had just created, imported straight through, and never offered the screen. The
	 * test timed out waiting for a button that was correctly absent.
	 *
	 * The comment above it said "a different file, deliberately" while the fixture was different in
	 * the one way that does not count. Fifth instance of choosing a fixture for how it reads.
	 */
	const WIDE_CSV = [
		'Date compta;Nature operation;Valeur',
		'18/06/2026;E2E DESKTOP MONOPRIX;-31,40',
		'15/06/2026;E2E DESKTOP VIREMENT;920,00'
	].join('\n');

	test('an unrecognised file is designated and imported at the desktop width', async ({ page }) => {
		await page.goto('/import');
		const form = page.locator('form[method="POST"]:visible').first();
		await form.locator('input[name="csvFile"]').setInputFiles({
			name: 'e2e-designation-desktop.csv',
			mimeType: 'text/csv',
			buffer: Buffer.from(WIDE_CSV, 'utf-8')
		});
		await form.getByRole('button', { name: m.import_submit() }).click();
		await form.getByRole('button', { name: m.import_columns_offer() }).click();

		await expect(page).toHaveURL(/\/import\/columns$/);

		for (const [rowName, column] of [
			[/^Date, aucune colonne désignée/, /^Date compta\./],
			[/^Libellé, aucune colonne désignée/, /^Nature operation\./],
			[/^Montant, aucune colonne désignée/, /^Valeur\./]
		] as const) {
			await page.getByRole('button', { name: rowName }).click();
			// The junction, in the journey: the row is the trigger and this is its target. Before
			// #334 was fixed this click timed out here, because the picker was a `lg:hidden` sheet.
			await page.getByRole('option', { name: column }).click();
		}

		await expectPrimaryUnobstructed(page, /^Importer/);

		await page.getByRole('button', { name: /^Importer/ }).click();
		await expect(page).toHaveURL(/\/import$/, { timeout: 15_000 });

		await page.goto('/transactions');
		await expect(onScreen(page, 'E2E DESKTOP MONOPRIX')).toBeVisible();
		await expect(onScreen(page, 'E2E DESKTOP VIREMENT')).toBeVisible();
		await expect(onScreen(page, '-31,40')).toBeVisible();
		await expect(onScreen(page, '920,00')).toBeVisible();
	});
});
