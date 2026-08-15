import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

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
 * ## The order of the last two steps is load bearing
 *
 * Correct FIRST, delete second. The recap is reached from the bad import's own row on `/imports`,
 * so deleting that import first removes the only route back to the columns and the next upload is
 * read through the same wrong correspondance. The dedupe key carries the label, so the corrected
 * rows arrive BESIDE the old ones rather than as duplicates, and the old batch has to go.
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
 */
function recoveryCsv(attempt: number): string {
	const suffix = attempt === 0 ? '' : ` r${attempt}`;
	return [
		`Zone P${suffix};Zone Q${suffix};Zone R${suffix};Zone S${suffix}`,
		'12/02/2019;E2E RECOVERY BOULANGERIE;REC0001;-6,40',
		'13/02/2019;E2E RECOVERY LIBRAIRIE;REC0002;-22,00'
	].join('\n');
}

function onScreen(page: import('@playwright/test').Page, text: string) {
	return page.getByText(text).filter({ visible: true }).first();
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

		// 4. The recap names the column AND the value it produced. The value is the evidence: the
		//    column name alone would not tell a user that `Zone R` was the wrong one.
		await expect(onScreen(page, `Zone R${suffix} · REC0001`)).toBeVisible();

		// 5. « Modifier les colonnes ». The file is asked for again because nothing kept it.
		await page.getByRole('button', { name: m.import_columns_modify() }).click();
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

		// 8. Delete the old import, second and not first. Found by ITS OWN id rather than by
		//    position: this suite shares a database, so "the last row" is a fact about whichever
		//    specs ran before this one.
		await page.goto('/imports');
		await page
			.locator('tbody tr')
			.filter({ has: page.locator(`a[href="${wrongBatchHref}"]`) })
			.getByRole('button', { name: m.common_delete() })
			.click();
		await page.getByRole('button', { name: m.imports_cancel_confirm_label() }).click();
		await expect(page).toHaveURL(/cancelled=1/);

		// 9. What the user came for. The corrected batch carries the merchants, and the reference
		//    codes are gone from the application entirely: the assertion that the corrected rows
		//    replaced the old ones rather than joining them.
		const fixedBatchHref = await page
			.locator('tbody tr')
			.first()
			.locator('a[href^="/transactions?importBatch="]')
			.getAttribute('href');
		await page.goto(fixedBatchHref!);
		await expect(onScreen(page, 'E2E RECOVERY BOULANGERIE')).toBeVisible();
		await expect(page.getByText('REC0001').filter({ visible: true })).toHaveCount(0);
	});
});
