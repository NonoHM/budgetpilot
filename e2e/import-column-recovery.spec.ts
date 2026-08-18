import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';
import { onScreen } from './screen-geometry';

/**
 * The journey that had no route: a memorised correspondance that is WRONG, and correcting it.
 *
 * ## Why this is one test and not five
 *
 * Every piece of this path existed before this spec and none of them were joined. The recap was a
 * MODE of `ColumnDesignationScreen`, covered by three component specs, that no route ever opened.
 * The « Modifier les colonnes » TapLink was built and reachable only by a prop nothing set. The
 * memorised mapping was written, read and applied by four tested modules and could not be looked
 * at. Each unit was correct and the assembly did not exist, which is exactly the class of defect a
 * test written at the level of the thing being built cannot see.
 *
 * So the assertion is the JOURNEY. Breaking it into "the recap renders" and "the correction saves"
 * would reproduce the failure this spec exists to catch.
 *
 * ## The case is wrong-but-VALID, which is the whole difficulty
 *
 * Designating the reference column as the label imports every row of every file with **nothing
 * invalid**: five read, five imported, zero rejected. No count is wrong, no banner appears, and
 * the invalid-rows path that #345 gave a way back from never fires. The transactions simply say
 * `REC0001` where they should say a merchant, forever, on every statement of that shape.
 *
 * ## The order is still load bearing, and the user no longer performs it
 *
 * Correct FIRST, delete second. The recap is reached from the bad import's own row on `/imports`,
 * so deleting that import first removes the only route back to the columns and the next upload is
 * read through the same wrong correspondance. The dedupe key carries the label, so the corrected
 * rows arrive BESIDE the old ones rather than as duplicates, and the old batch has to go.
 *
 * What changed is WHO does it. The run now carries the batch id and the user's consent, so the
 * delete happens inside the import in that same order, and two steps of this spec went with it:
 * the guard no longer fires (the batch being replaced is excluded from the collision search) and
 * there is no manual delete to perform afterwards. Both are now asserted as ABSENCES, which is the
 * shape that needs a figure beside it rather than a bare `toHaveCount(0)` on a page that might not
 * have rendered at all.
 *
 * ## Thirteen steps to eight, and this is where the claim is checked
 *
 * The wave's headline number is a claim about a journey, and a journey is the only level that can
 * hold it. Steps 9 to 13 of the old path lived in this file: dismiss a guard, return to `/imports`,
 * work out which of two identical rows is the old one, delete it, confirm an irreversible delete.
 * They are gone from the spec because they are gone from the product.
 */
test.describe.configure({ mode: 'serial' });

/**
 * Retry aware, for the same reason as the designation suite: designating MEMORISES. A replay that
 * uploaded the shape the previous attempt had already learned would be recognised, imported
 * straight through, and would never reach the screen this journey starts on.
 *
 * DATED 2019, well outside the seeded window. This suite shares one database in declaration order,
 * and a 2026 row left behind here once displaced the dashboard row `taplink-avatar.spec.ts`
 * asserts on, failing a spec that has nothing to do with imports.
 *
 * THE AMOUNTS CARRY THE ATTEMPT TOO, and that is the half this used to miss. The suffix varies the
 * HEADERS, which is what the fingerprint is taken over, and left the rows byte for byte identical.
 * So a retry designated a fresh correspondance and then deduplicated every row against the first
 * attempt's transactions, importing zero and failing at step 2 on a page that was correctly empty.
 * Measured: the first attempt failed at step 4 for an unrelated reason, and both retries then
 * failed at step 2 instead, which reads as a different defect and is the same fixture.
 */
function recoveryCsv(attempt: number): string {
	const suffix = attempt === 0 ? '' : ` r${attempt}`;
	return [
		`Zone P${suffix};Zone Q${suffix};Zone R${suffix};Zone S${suffix}`,
		`12/02/2019;E2E RECOVERY BOULANGERIE;REC0001;-6,4${attempt}`,
		`13/02/2019;E2E RECOVERY LIBRAIRIE;REC0002;-22,0${attempt}`
	].join('\n');
}

test.describe('a memorised correspondance that is wrong can be corrected', () => {
	test('designate the wrong column, notice it in the recap, and end with correct labels', async ({
		page
	}, testInfo) => {
		const suffix = testInfo.retry === 0 ? '' : ` r${testInfo.retry}`;
		const csv = recoveryCsv(testInfo.retry);
		const upload = async () => {
			const form = page.locator('form[method="POST"]:visible').first();
			await form.locator('input[name="csvFile"]').setInputFiles({
				name: 'e2e-recovery.csv',
				mimeType: 'text/csv',
				buffer: Buffer.from(csv, 'utf-8')
			});
			await form.getByRole('button', { name: m.import_submit() }).click();
			await form.getByRole('button', { name: m.import_columns_offer() }).click();
			await expect(page).toHaveURL(/\/import\/columns$/);
		};

		// 1. The wrong designation. `Zone R` is the reference column: valid, parses, and useless.
		await page.goto('/import');
		await upload();
		for (const [rowName, column] of [
			[/^Date, aucune colonne désignée/, new RegExp(`^Zone P${suffix}\\.`)],
			[/^Libellé, aucune colonne désignée/, new RegExp(`^Zone R${suffix}\\.`)],
			[/^Montant, aucune colonne désignée/, new RegExp(`^Zone S${suffix}\\.`)]
		] as const) {
			await page.getByRole('button', { name: rowName }).click();
			await page.getByRole('option', { name: column }).click();
		}
		await page.getByRole('button', { name: /^Importer/ }).click();
		await expect(page).toHaveURL(/\/import$/, { timeout: 15_000 });

		// 2. Nothing is flagged anywhere. The rows landed, and they landed wrong. Read through the
		//    batch's own filter rather than the whole list: this suite shares a database and an
		//    unfiltered list is a fact about every spec that ran before it.
		await page.goto('/imports');
		const wrongBatchHref = await page
			.locator('tbody tr')
			.first()
			.locator('a[href^="/transactions?importBatch="]')
			.getAttribute('href');
		expect(wrongBatchHref).toContain('importBatch=');
		await page.goto(wrongBatchHref!);
		await expect(onScreen(page, 'REC0001')).toBeVisible();

		// 3. The entry point the plate's §3.7 puts on `/imports`, and the whole of what was missing.
		await page.goto('/imports');
		await expect(onScreen(page, m.import_columns_recognised())).toBeVisible();
		await onScreen(page, m.import_columns_view()).click();
		await expect(page).toHaveURL(/\/imports\/[^/]+\/columns$/);

		// 4. The recap states TWO FACTS rather than one pairing, and the change is not cosmetic. The
		//    column is read live from the correspondance and the value comes from this batch's own
		//    transactions, so a middot between them claimed a relation between a fact about now and a
		//    fact about then (A8). The value is still the evidence: the column name alone would not
		//    tell a user that `Zone R` was the wrong one.
		await expect(
			onScreen(page, m.import_columns_recap_column_fact({ column: `Zone R${suffix}` }))
		).toBeVisible();
		await expect(
			onScreen(page, m.import_columns_recap_value_fact({ value: 'REC0001' }))
		).toBeVisible();

		// 5. « Modifier les colonnes ». The file is asked for again because nothing kept it.
		await page.getByRole('button', { name: m.import_columns_modify() }).click();
		await expect(page).toHaveURL(/\/import\?correct=/);

		// 5b. The WRONG file, handed back. Refused with its reason rather than opened: designating
		//     through it would write a new correspondance for the file picked by mistake and leave
		//     the one under correction exactly as it was, silently.
		const wrongForm = page.locator('form[method="POST"]:visible').first();
		await wrongForm.locator('input[name="csvFile"]').setInputFiles({
			name: 'e2e-recovery-other.csv',
			mimeType: 'text/csv',
			buffer: Buffer.from(`Autre A${suffix};Autre B${suffix}\n12/02/2019;X\n`, 'utf-8')
		});
		await wrongForm.getByRole('button', { name: m.import_submit() }).click();
		await expect(onScreen(page, m.import_columns_correct_wrong_file())).toBeVisible({
			timeout: 15_000
		});
		await expect(page).toHaveURL(/\/import\?correct=/);

		// 6. État 2, désignations intactes: the user came to change ONE row.
		await upload();
		for (const role of ['Date', 'Libellé', 'Montant']) {
			await expect(
				page.getByRole('button', { name: new RegExp(`^${role}, colonne désignée`) })
			).toBeVisible();
		}

		// 7. The correction itself.
		await page.getByRole('button', { name: /^Libellé, colonne désignée/ }).click();
		await page.getByRole('option', { name: new RegExp(`^Zone Q${suffix}\\.`) }).click();
		await page.getByRole('button', { name: /^Importer/ }).click();
		await expect(page).toHaveURL(/\/import$/, { timeout: 15_000 });

		// 7b. THE GUARD DOES NOT FIRE, and its silence is the win rather than an omission.
		//
		//     This run re-reads the statement the batch it replaces was read from, so it matches that
		//     batch on all three terms by construction: same period, same count, same totals, and no
		//     fingerprint in common because the label moved to another column. Before
		//     `excludeBatchId`, that raised the one dialog it could not usefully raise, against the
		//     very import the user came to fix. This spec used to answer it and carry on.
		//
		//     Asserted as an absence WITH A FIGURE beside it: an absence on its own passes over a
		//     dialog that failed to render for any other reason, so the summary is waited for first
		//     and the count is taken once the page has settled.
		await expect(onScreen(page, m.import_summary_heading())).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText(m.import_collision_title()).filter({ visible: true })).toHaveCount(
			0
		);

		// 8. NO MANUAL DELETE, and no dialog to dismiss before it. The control on the correction screen
		//    was left ticked, which is its default, so the old import went with the write rather than
		//    being left for the user to find among two identical rows.
		//
		//    The summary says so BY NAME, which is what the user is owed for a deletion consented to two
		//    steps back on a screen that named the import it would destroy.
		//
		//    The old journey's steps 9 to 13 lived here: dismiss a guard, return to `/imports`, work out
		//    which of two identical rows is the old one, delete it, confirm. All five are gone, and this
		//    is where that is asserted rather than in a step count in a document.
		//    Located by the message's INVARIANT half, obtained by rendering it around a sentinel and
		//    keeping what follows. The date is this batch's own `createdAt` and the test cannot know it;
		//    retyping « a été supprimé » instead would assert a French literal an English locale never
		//    renders, and would put the catalogue and this spec on two sources for one string.
		const DATE_SLOT = '@@';
		const deletedTail = m
			.import_correct_delete_old_done({ date: DATE_SLOT })
			.split(DATE_SLOT)[1]
			.trim();
		await expect(onScreen(page, deletedTail)).toBeVisible();
		await page.goto('/imports');
		await expect(page.locator(`tbody tr a[href="${wrongBatchHref}"]`)).toHaveCount(0);

		// 9. What the user came for. The corrected batch carries the merchants, and the reference
		//    codes are gone from the application entirely: the assertion that the corrected rows
		//    replaced the old ones rather than joining them.
		const fixedBatchHref = await page
			.locator('tbody tr')
			.first()
			.locator('a[href^="/transactions?importBatch="]')
			.getAttribute('href');
		// The corrected batch is a DIFFERENT batch, which is what makes the deletion above a replacement
		// rather than an edit in place. Without this the two hrefs could be equal and every assertion
		// below would still pass, over a journey that had done nothing.
		expect(fixedBatchHref).not.toBe(wrongBatchHref);
		await page.goto(fixedBatchHref!);
		await expect(onScreen(page, 'E2E RECOVERY BOULANGERIE')).toBeVisible();
		await expect(page.getByText('REC0001').filter({ visible: true })).toHaveCount(0);
	});
});
