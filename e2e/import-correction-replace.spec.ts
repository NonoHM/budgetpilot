import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';
import { onScreen } from './screen-geometry';

/**
 * The `replacing` framing: a correction that replaces one import AND duplicates another.
 *
 * ## Why this needs its own journey
 *
 * `correctionContext` has three values and the third has never been seen in a browser. `none` and
 * `keeping` are reachable from the ordinary paths; `replacing` needs a state nobody arrives at by
 * accident, and it is the only case where TWO TRUE FACTS have to be said at once: the import being
 * corrected really is about to be replaced, and the statement drawn above really is a third import
 * this run would duplicate. Saying one of them is the same defect one level along.
 *
 * It was unit covered from the day it was written. That is exactly the coverage that misses an
 * assembly: the dialog's own spec proves it renders three framings when given three values, the
 * page's spec proves the page derives the right value, and neither says a browser can reach the
 * third one. The title bug found in the wave 3 audit lived in precisely that gap for a week, with
 * the body branching three ways and the heading collapsing to a boolean.
 *
 * ## The three batches, and why each fixture column is the one it is
 *
 * The guard fires on three terms at once: the periods overlap, the money is identical to the cent,
 * and deduplication will not absorb the run. So the run has to match a THIRD batch on period, count
 * and totals while sharing no label with it, and it has to be correcting a SECOND batch that is
 * excluded from the search. That forces the fixture rather than leaving it to taste:
 *
 *   A  generic upload, auto detected     label = the MERCHANT column
 *   B  opaque upload, hand designated    label = the REFERENCE column   (this is what gets replaced)
 *   correction of B                      label = the DETAIL column
 *
 * Three columns carrying three different values for the same transactions, so no two of the three
 * runs ever share a deduplication key. Point any two of them at one column and the run is absorbed
 * as duplicates, lands zero rows, and the withholding guard fires instead of the replacement: the
 * test would pass its early assertions and prove nothing about the framing it exists for.
 *
 * The amounts and dates are identical across all three by construction, because that is what makes
 * the periods overlap and the totals match to the cent.
 *
 * ## Dated 2017, and that is isolation rather than decoration
 *
 * This suite shares one database in declaration order. `import-column-recovery.spec.ts` seeds 2019
 * and its statement has the same shape as this one; two files seeding overlapping periods would
 * make each one's collision guard fire on the other's batches, and the failure would read as a
 * defect in whichever ran second. A year no other spec uses is what keeps this journey's three
 * batches the only three that can match each other.
 */
test.describe.configure({ mode: 'serial' });

/**
 * Retry aware, and for a sharper reason than the sibling suite's. Designating MEMORISES, so a
 * replay that uploaded the shape the previous attempt already learned would be recognised and
 * imported straight through, never reaching the designation screen this journey needs. The suffix
 * changes the header cells, which is what the fingerprint is taken over.
 */
function statement(attempt: number) {
	const suffix = attempt === 0 ? '' : ` r${attempt}`;
	// The same four transactions, carrying three DISJOINT label sets. No row shares a merchant, a
	// reference or a detail with any other, which is what stops any two of the three runs from
	// deduplicating against each other.
	//
	// The AMOUNTS carry the attempt as well as the headers, and the sibling suite is why. There the
	// suffix varied only the header cells, which is what the fingerprint is taken over, and left the
	// rows byte for byte identical: every retry designated a fresh correspondance and then
	// deduplicated all of its transactions against the first attempt's, importing zero rows and
	// failing several steps later on a page that was correctly empty. Varying the cents makes each
	// attempt a genuinely different statement. Within one attempt they stay identical across all
	// three runs, which is what the collision guard compares to the cent.
	const rows = [
		{
			date: '05/03/2017',
			merchant: 'E2E REPLACE FROMAGERIE',
			reference: 'RPL0001',
			detail: 'TICKET 4471',
			cents: `11,8${attempt}`
		},
		{
			date: '06/03/2017',
			merchant: 'E2E REPLACE PAPETERIE',
			reference: 'RPL0002',
			detail: 'TICKET 4472',
			cents: `31,5${attempt}`
		},
		{
			date: '07/03/2017',
			merchant: 'E2E REPLACE QUINCAILLERIE',
			reference: 'RPL0003',
			detail: 'TICKET 4473',
			cents: `64,2${attempt}`
		},
		{
			date: '08/03/2017',
			merchant: 'E2E REPLACE TRAITEUR',
			reference: 'RPL0004',
			detail: 'TICKET 4474',
			cents: `18,0${attempt}`
		}
	];

	// A: the header names the generic profile recognises unaided, so this import opens no screen.
	// Comma separated with a decimal POINT, which is the shape `scr/synthetic/out/generic.csv` uses:
	// a decimal comma inside a comma separated file would split every amount into two cells.
	const generic = [
		'date,label,amount',
		...rows.map((r) => `${r.date},${r.merchant},-${r.cents.replace(',', '.')}`)
	].join('\n');

	// B: four columns nothing can recognise, so the designation screen opens. Semicolon separated
	// with a decimal comma, the shape the sibling recovery suite already proves the parser reads.
	//
	//   Bloc W date · Bloc X reference · Bloc Y detail · Bloc Z amount
	//
	// Both the reference and the detail are present because the journey designates one and then
	// corrects to the other. A fixture carrying only the column it starts on could not be corrected
	// to anything the third batch does not already hold.
	const opaque = [
		`Bloc W${suffix};Bloc X${suffix};Bloc Y${suffix};Bloc Z${suffix}`,
		...rows.map((r) => `${r.date};${r.reference};${r.detail};-${r.cents}`)
	].join('\n');

	return { suffix, rows, generic, opaque };
}

test.describe('a correction that replaces one import and would duplicate another', () => {
	test('says both facts, replaces the batch it corrects, and leaves the third alone', async ({
		page
	}, testInfo) => {
		const { suffix, opaque, generic } = statement(testInfo.retry);

		const uploadTo = async (name: string, csv: string) => {
			const form = page.locator('form[method="POST"]:visible').first();
			await form.locator('input[name="csvFile"]').setInputFiles({
				name,
				mimeType: 'text/csv',
				buffer: Buffer.from(csv, 'utf-8')
			});
			await form.getByRole('button', { name: m.import_submit() }).click();
		};

		// 1. BATCH A, recognised without a screen. This is the import the correction will be warned
		//    about duplicating, and it has to exist first so it is not the one being replaced.
		await page.goto('/import');
		await uploadTo('e2e-replace-generic.csv', generic);
		await expect(onScreen(page, m.import_summary_heading())).toBeVisible({ timeout: 15_000 });

		// 2. BATCH B, the same statement through headers nothing recognises, designated by hand onto
		//    the REFERENCE column. Wrong but valid, which is the shape this whole wave exists for.
		await page.goto('/import');
		await uploadTo('e2e-replace-opaque.csv', opaque);
		await page.getByRole('button', { name: m.import_columns_offer() }).click();
		await expect(page).toHaveURL(/\/import\/columns$/);
		for (const [rowName, column] of [
			[/^Date, aucune colonne désignée/, new RegExp(`^Bloc W${suffix}\\.`)],
			[/^Libellé, aucune colonne désignée/, new RegExp(`^Bloc X${suffix}\\.`)],
			[/^Montant, aucune colonne désignée/, new RegExp(`^Bloc Z${suffix}\\.`)]
		] as const) {
			await page.getByRole('button', { name: rowName }).click();
			await page.getByRole('option', { name: column }).click();
		}
		await page.getByRole('button', { name: /^Importer/ }).click();

		// 2b. A and B are the same statement read two ways, so the guard fires HERE, in its ordinary
		//     `none` framing. The journey confirms: the user is knowingly holding two readings, which
		//     is the state the blind session ended in and the precondition for step 4.
		await expect(onScreen(page, m.import_collision_title())).toBeVisible({ timeout: 15_000 });
		await page.getByRole('button', { name: m.import_collision_confirm() }).click();
		await expect(page).toHaveURL(/\/import$/, { timeout: 15_000 });
		await expect(onScreen(page, m.import_summary_heading())).toBeVisible({ timeout: 15_000 });

		// 3. Open B's recap and start the correction. B is the newest import, so it is the first row.
		await page.goto('/imports');
		const replacedHref = await page
			.locator('tbody tr')
			.first()
			.locator('a[href^="/transactions?importBatch="]')
			.getAttribute('href');
		expect(replacedHref).toContain('importBatch=');
		await onScreen(page, m.import_columns_view()).click();
		await expect(page).toHaveURL(/\/imports\/[^/]+\/columns$/);
		await page.getByRole('button', { name: m.import_columns_modify() }).click();
		await expect(page).toHaveURL(/\/import\?correct=[^&]+&batch=/);

		// 4. The correction: label moves to the DETAIL column, which neither A nor B ever used.
		await uploadTo('e2e-replace-opaque.csv', opaque);
		await page.getByRole('button', { name: m.import_columns_offer() }).click();
		await expect(page).toHaveURL(/\/import\/columns$/);

		// 4b. THE CONTROL NAMES THE IMPORT IT WILL DELETE, and it arrives ticked. Both are asserted
		//     rather than taken on trust: the default is what makes this a replacement, and the name is
		//     what the user is consenting against. Located by the message's invariant half so the
		//     assertion and the catalogue are not two sources for one string.
		//
		//     ASSERTED HERE AND NOT ON `/import`, which is Planche 5c: the question moved to the moment
		//     it forms, after the offending role has been changed and beside the count of what will be
		//     imported. Above the file picker it asked the fate of the old import before the file was
		//     chosen and before knowing the correction would succeed.
		const DATE_SLOT = '@@';
		const [labelHead] = m.import_correct_delete_old_label({ date: DATE_SLOT }).split(DATE_SLOT);
		const consent = page.locator('input[type="checkbox"]:visible').first();
		await expect(consent).toBeChecked();
		await expect(onScreen(page, labelHead.trim())).toBeVisible();
		await page.getByRole('button', { name: /^Libellé, colonne désignée/ }).click();
		await page.getByRole('option', { name: new RegExp(`^Bloc Y${suffix}\\.`) }).click();
		// PLANCHE 5c: the consent moved into this footer, pre-ticked, so the press PROPOSES and the
		// confirmation consents. One deliberate intention for one irreversible result, and it is the
		// step that took this journey from 8 to 9.
		await page.getByRole('button', { name: /^Importer/ }).click();
		await page
			.getByRole('dialog')
			.getByRole('button', { name: m.import_columns_replace_confirm_label() })
			.click();

		// 5. THE REPLACING FRAMING, and BOTH facts. B is excluded from the collision search because it
		//    is being replaced, so what fires is A: a third import this run really would duplicate.
		//
		//    The heading is asserted as a presence AND the keeping heading as an absence, because the
		//    two are both plausible strings on this screen and only their exchange is the defect. That
		//    exchange shipped: the body branched three ways and the title read the prop as a boolean.
		await expect(onScreen(page, m.import_collision_replacing_heading())).toBeVisible({
			timeout: 15_000
		});
		await expect(
			page.getByText(m.import_collision_keeping_heading()).filter({ visible: true })
		).toHaveCount(0);
		await expect(onScreen(page, m.import_collision_replacing_body())).toBeVisible();
		// The duplication warning survives the reframing. A dialog that replaced the consequence
		// rather than adding to it would pass every assertion above.
		await expect(onScreen(page, m.import_collision_consequence())).toBeVisible();

		// 5b. NO DANGER TINT on the confirm, in a framing where the press imports rather than destroys.
		//     Read off the rendered colour and compared against the app's own destructive control, so a
		//     palette change cannot quietly invert it. `Supprimer` on `/imports` is that control.
		const confirmBackground = await page
			.locator('[role="dialog"] button[type="submit"]')
			.evaluate((element) => getComputedStyle(element).backgroundColor);
		expect(confirmBackground).not.toMatch(/oklch\(0?\.[0-6]\d*\s+0\.[1-9]/);

		await page.getByRole('button', { name: m.import_collision_correction_confirm() }).click();
		await expect(page).toHaveURL(/\/import$/, { timeout: 15_000 });

		// 6. The replacement happened and said so by name, B is gone, and A is untouched. The last of
		//    those is the one this journey adds: a replace that also deleted the third import would
		//    satisfy every assertion about B.
		const [, deletedTail] = m.import_correct_delete_old_done({ date: DATE_SLOT }).split(DATE_SLOT);
		await expect(onScreen(page, deletedTail.trim())).toBeVisible({ timeout: 15_000 });

		await page.goto('/imports');
		await expect(page.locator(`tbody tr a[href="${replacedHref}"]`)).toHaveCount(0);
		await expect(onScreen(page, 'E2E REPLACE FROMAGERIE')).toHaveCount(0);

		// 7. What each surviving batch carries. A still holds the merchants it was imported with, and
		//    the corrected batch holds the detail column. The reference codes B was read through are
		//    gone from the application entirely, which is the assertion that B was replaced rather
		//    than joined.
		const correctedHref = await page
			.locator('tbody tr')
			.first()
			.locator('a[href^="/transactions?importBatch="]')
			.getAttribute('href');
		expect(correctedHref).not.toBe(replacedHref);
		await page.goto(correctedHref!);
		await expect(onScreen(page, 'TICKET 4471')).toBeVisible();
		await expect(page.getByText('RPL0001').filter({ visible: true })).toHaveCount(0);
	});
});
