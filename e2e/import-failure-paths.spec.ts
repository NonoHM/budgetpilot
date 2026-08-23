import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';
import { expectPrimaryUnobstructed, onScreen } from './screen-geometry';
import { chooseStatementAccount } from './choose-account';

/**
 * The import path's failure paths, which are the ones no level below this can see.
 *
 * Two fixes are under test and both are SEAMS: one between the browser's transport and the
 * server's refusal, one between two mounts of the same form. A seam belongs to neither piece it
 * joins, so every unit and component test of both pieces passed while the assembled behaviour was
 * broken. That is the class recorded in `AGENTS.md` after #334, and this file is the level at which
 * it is observable.
 *
 * ## Nothing here imports a row
 *
 * Every test in this file ends in a REFUSAL, by construction: the two upload tests stop at the
 * designation offer, and the two designation tests are prevented from reaching the server at all.
 * So no transaction, no import batch and no memorised correspondance is written, and this spec
 * cannot displace the shared dataset the rest of the suite reads in declaration order.
 *
 * The dates are 2019 regardless, well outside the seeded window, following the reason recorded in
 * `import-column-recovery.spec.ts`: a 2026 row left behind here once displaced the dashboard row
 * `taplink-avatar.spec.ts` asserts on.
 */

/**
 * Retry aware, for the reason `import-column-designation.spec.ts` records: designating memorises,
 * so a retry that replayed the same header shape would meet a file the application has learned and
 * would never open the designation screen. These tests do not memorise, but they DO depend on the
 * shape being unrecognised, and the suite shares one database across files.
 */
function unrecognisedCsv(attempt: number, marker: string): string {
	const suffix = `${marker}${attempt === 0 ? '' : ` r${attempt}`}`;
	return [
		`Champ A${suffix};Champ B${suffix};Champ C${suffix}`,
		'11/03/2019;E2E FAILPATH BOULANGERIE;-6,40',
		'12/03/2019;E2E FAILPATH LIBRAIRIE;-22,00'
	].join('\n');
}

function csvFile(attempt: number, marker: string) {
	return {
		name: 'e2e-failure-paths.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(unrecognisedCsv(attempt, marker), 'utf-8')
	};
}

/**
 * The VISIBLE form, never `.first()`.
 *
 * `/import` renders its whole upload form twice, `hidden lg:block` and `lg:hidden`. `.first()` is
 * always the desktop copy, so at 390 every interaction with it times out in a way that reads like a
 * missing element rather than like the wrong element.
 */
function visibleForm(page: import('@playwright/test').Page) {
	return page.locator('form[method="POST"]:visible').first();
}

async function reachDesignationScreen(
	page: import('@playwright/test').Page,
	attempt: number,
	marker: string
) {
	await page.goto('/import');
	const form = visibleForm(page);
	await form.locator('input[name="csvFile"]').setInputFiles(csvFile(attempt, marker));
	await form.getByRole('button', { name: m.import_submit() }).click();
	await form.getByRole('button', { name: m.import_columns_offer() }).click();
	await expect(page).toHaveURL(/\/import\/columns$/);

	for (const [rowName, column] of [
		[/^Date, aucune colonne désignée/, /^Champ A/],
		[/^Libellé, aucune colonne désignée/, /^Champ B/],
		[/^Montant, aucune colonne désignée/, /^Champ C/]
	] as const) {
		await page.getByRole('button', { name: rowName }).click();
		await page.getByRole('option', { name: column }).click();
	}
}

/**
 * ## B2, the silent primary
 *
 * `ActionResult` is a four-member union and the client read two of them. `redirect` and `error`
 * fell through to a `return` that did nothing, and the `.catch` stopped the spinner and said
 * nothing. The user pressed « Importer », and the application did not respond, for as long as they
 * were willing to keep pressing.
 *
 * The expired session is the sharp case, because the server behaves CORRECTLY there: `requireUser`
 * throws `redirect(303, '/login')` and refuses the request. ASVS 5.0 **V7.4.1**, a terminated
 * session disallowing any further use, was already satisfied and is not what these tests restore.
 * What was missing is that the refusal reached the person. That is **V16.5.1** and **V16.5.3**, not
 * V7, and stating which row applies is the point of citing one at all.
 */
test.describe('the designation screen answers when the import call fails', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('an expired session sends the user to log in rather than doing nothing', async ({
		page,
		context
	}, testInfo) => {
		await reachDesignationScreen(page, testInfo.retry, 'X');

		// The session dies while the user is mid-task, which is exactly when a long designation is
		// most likely to outlive it. The cookie is dropped rather than the server being stubbed, so
		// the request that follows is a genuine unauthenticated one and `requireUser` answers it.
		await context.clearCookies();

		// The account is part of every designation now; see e2e/choose-account.ts.
		await chooseStatementAccount(page);
		await page.getByRole('button', { name: /^Importer/ }).click();

		// BEFORE: this URL never changed and no message ever appeared. The assertion is the
		// navigation, because that is the observable difference between a refusal that arrives and a
		// refusal that is dropped on the floor.
		await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
	});

	test('a failed call says so, and does not push the primary off the screen', async ({
		page
	}, testInfo) => {
		await reachDesignationScreen(page, testInfo.retry, 'Y');

		// The transport itself fails. `deserialize` never runs, so this lands in the `.catch` that
		// used to stop the spinner and return. Scoped to POST so the page's own navigation and asset
		// requests are untouched.
		await page.route('**/import/columns', async (route) => {
			if (route.request().method() === 'POST') await route.abort('failed');
			else await route.fallback();
		});

		// The account is part of every designation now; see e2e/choose-account.ts.
		await chooseStatementAccount(page);
		await page.getByRole('button', { name: /^Importer/ }).click();

		await expect(onScreen(page, m.import_columns_error_unexpected())).toBeVisible({
			timeout: 15_000
		});

		// THE HALF THAT IS NOT ABOUT THE MESSAGE, and the reason this test is here rather than in a
		// component spec. The banner is a sibling of a screen whose root is `h-full` inside an
		// `h-dvh` main, so before the layout fix its height was ADDED to a full 844 and the footer
		// carrying the primary went below the fold. The fix for a silent failure would have shipped
		// an occluded control: the user would finally be told what went wrong, and would no longer be
		// able to reach the button that retries it.
		await expectPrimaryUnobstructed(page, /^Importer/);

		// FAILS CLOSED (ASVS 5.0 V16.5.3): the designations survive, so the user retries rather than
		// redesignating. A fix that reported the failure and reset the screen would satisfy the
		// assertion above and still lose the work.
		await expect(page).toHaveURL(/\/import\/columns$/);
		await expect(page.getByRole('button', { name: /^Montant, colonne désignée/ })).toBeVisible();
	});
});

/**
 * ## B4, the file lost between two mounts of one form
 *
 * `/import` renders its upload form twice and each mount carried its own `<input type="file">`.
 * Both are named `csvFile`, but they sit in two separate `<form>` elements, so only the submitted
 * one is ever posted. Measured before the fix: choose a file at 1280, resize to 390 without
 * reloading, and the visible input read `files.length` 0 while the hidden one still held the file.
 * Pressing Import issued NO request and showed Chromium's own `valueMissing` bubble, in English, on
 * a French page.
 *
 * The assertion is therefore that the SERVER answered. Anything the server produced proves a
 * request was made, which is the thing that did not happen.
 */
test.describe('the chosen statement survives a change of width', () => {
	test('a file picked at 1280 is still submitted after a resize to 390', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/import');
		await visibleForm(page)
			.locator('input[name="csvFile"]')
			.setInputFiles(csvFile(testInfo.retry, 'Z'));

		await page.setViewportSize({ width: 390, height: 844 });

		const form = visibleForm(page);
		// The label is read before submitting, because it is what the USER sees and it is what was
		// wrong: it reverted to « Aucun fichier sélectionné » over an input that held nothing.
		await expect(form.getByText(m.common_file_dropzone_no_file())).not.toBeVisible();

		await form.getByRole('button', { name: m.import_submit() }).click();
		await expect(form.getByText(m.import_columns_offer_explanation())).toBeVisible({
			timeout: 15_000
		});
	});

	test('a file picked at 390 is still submitted after a resize to 1280', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/import');
		await visibleForm(page)
			.locator('input[name="csvFile"]')
			.setInputFiles(csvFile(testInfo.retry, 'W'));

		await page.setViewportSize({ width: 1280, height: 800 });

		const form = visibleForm(page);
		await form.getByRole('button', { name: m.import_submit() }).click();
		await expect(form.getByText(m.import_columns_offer_explanation())).toBeVisible({
			timeout: 15_000
		});
	});

	/**
	 * THE DIRECTION THIS CHANGE IS NOT MOVING IN.
	 *
	 * `required` came off both inputs, so the browser no longer refuses an empty submit before a
	 * request is sent. The loss would be that an empty submit stops being refused AT ALL, and this
	 * is the test that would catch it.
	 *
	 * ASVS 5.0 **V2.2.2**: validation is enforced at a trusted service layer, and client-side
	 * validation "improves usability and should be encouraged" without being the control. The
	 * control is `/import`'s own action, which refuses an absent or empty upload, and it answers in
	 * the page's language rather than the browser's -- which is the user-visible half of this fix.
	 */
	test('submitting with no file is refused by the application, in its own language', async ({
		page
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/import');

		const form = visibleForm(page);
		await form.getByRole('button', { name: m.import_submit() }).click();

		await expect(onScreen(page, m.import_error_no_file())).toBeVisible({ timeout: 15_000 });
	});
});
