import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';
import { E2E_BASE_URL } from './config';

/**
 * #476: TWO ACCOUNTS AT ONE BANK, walked end to end in a real browser.
 *
 * A recognised file cannot say which of two accounts of its own format it belongs to. The server
 * refuses, and until this the refusal named the designation screen, which never opens for a
 * recognised file (ruling A1) and whose route bounces a direct visit. The import could not be
 * completed at any price. What is walked here is the route through.
 *
 * ## Why a browser and not the component spec next door
 *
 * `account-question.svelte.spec.ts` measures the host's markup: that the control renders at both
 * widths, that the mounts do not share an id, that the answer reaches the request. None of it can
 * say whether the answer SURVIVES a real POST, and none of it can measure the panel against a
 * fixed bottom navigation that only exists on a real page.
 *
 * ## The overlap assertion is a measurement, not a guess
 *
 * MEASURED at 390 with four accounts of one source, before the row was scrolled into view:
 * `PANEL_BOTTOM=845 NAV_TOP=743` on an 844 px viewport, so the panel ended past the bottom of the
 * screen with its last options behind the navigation and unreachable by touch. After:
 * `PANEL_BOTTOM=694 NAV_TOP=743`. The component is correct and was correct there too; the
 * designation screen it was built for is a focused full-screen task with no bottom bar, and this
 * host has one. That is why the assertion lives here rather than in the component's own battery.
 */

const CSV = [
	'date;label;amount;category',
	'2026-06-01;AUCHAN COURSES 476;-42,10;Autre',
	'2026-06-02;SNCF 476;-30,00;Autre'
].join('\n');

/**
 * Two accounts of the statement source, which is what makes the file ambiguous.
 *
 * Created through the real endpoint rather than seeded, because `createStatementAccount` is what
 * decides the source and a fixture writing `source: 'csv'` by hand would be the test and the thing
 * under test on one source. Named per worker: two workers creating at once are two users, and a
 * collision would refuse the second for a reason about the first.
 */
async function makeAccount(page: import('@playwright/test').Page, name: string): Promise<string> {
	const response = await page.request.post(`${E2E_BASE_URL}/import/accounts`, {
		headers: { Origin: E2E_BASE_URL },
		multipart: { name: `${name} ${process.env.TEST_WORKER_INDEX ?? '0'}` }
	});
	expect(response.ok()).toBe(true);
	const payload = (await response.json()) as { account: { id: string } };
	return payload.account.id;
}

/**
 * ARCHIVING WHAT THIS FILE CREATED IS PART OF THE TEST, not tidiness.
 *
 * MEASURED: the first version of this file left its two accounts behind, and the full suite went
 * from `190 passed, 1 flaky` to `7 failed`. Every one of the seven is an import spec, and all of
 * them for one reason: two accounts of source `csv` is exactly the state this file exists to
 * create, so every later import in the run met the refusal instead of importing. `choose-account.ts`
 * says as much in advance, that no spec has more than one statement account "and the ones that will
 * are the ones testing the choice itself".
 *
 * Archiving rather than deleting, because archiving is the operation the product has and it is what
 * takes an account out of the by-source lookup. The rows already imported stay where they are, which
 * is what archiving means.
 */
async function archiveAccounts(page: import('@playwright/test').Page, ids: string[]) {
	for (const id of ids) {
		const response = await page.request.post(`${E2E_BASE_URL}/settings?/archiveAccount`, {
			headers: { Origin: E2E_BASE_URL },
			multipart: { id, archived: 'true' }
		});
		expect(response.ok()).toBe(true);
	}
}

async function offerAFile(
	page: import('@playwright/test').Page,
	form: ReturnType<typeof page.locator>
) {
	await form.locator('input[name="csvFile"]').setInputFiles({
		name: 'releve-476.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(CSV, 'utf-8')
	});
	await form.getByRole('button', { name: m.import_submit() }).click();
}

test('a statement ambiguous between two accounts is imported into the one chosen', async ({
	page
}) => {
	// SEPARATES: « the refusal offers a control and the answer completes the import » FROM « the
	// refusal states a problem and the run ends there », which is the dead end. Asserted on the
	// account the summary NAMES, not on the absence of an error: a refusal and a success that
	// mentions nothing are the same silence.
	await page.goto('/import');
	const created = [
		await makeAccount(page, 'BP Compte courant 476'),
		await makeAccount(page, 'BP Livret A 476')
	];
	await page.goto('/import');

	const form = page.locator('form[method="POST"]').first();
	await offerAFile(page, form);

	await expect(page.getByText(m.import_account_error_ambiguous_auto()).first()).toBeVisible();
	const question = page.getByTestId('import-account-question').first();
	await expect(question).toBeVisible();

	await question.locator('button').first().click();
	const chosen = page.getByRole('option', { name: /Livret A 476/ }).first();
	await expect(chosen).toBeVisible();
	await chosen.click();

	await form.getByRole('button', { name: m.import_submit() }).click();

	/**
	 * THE SUMMARY, not the row.
	 *
	 * The first version of this assertion looked for the account's NAME, and it passed against the
	 * account row that was already on screen before the submit: a run where nothing was posted at
	 * all would have been green. The sentence below exists only after transactions have landed and
	 * it carries the COUNT, so it separates « the file was imported into the chosen account » from
	 * « the chosen account is displayed ».
	 */
	const summary = page.getByText(
		new RegExp(`2 lignes importées dans BP Livret A 476 ${process.env.TEST_WORKER_INDEX ?? '0'}`)
	);
	await expect(summary.first()).toBeVisible({ timeout: 15_000 });

	// And the refusal is gone rather than standing beside a summary that contradicts it.
	await expect(page.getByText(m.import_account_error_ambiguous_auto())).toHaveCount(0);

	await archiveAccounts(page, created);
});

test('the account panel at 390 stays clear of the bottom navigation', async ({ page }) => {
	// SEPARATES: « every option can be reached » FROM « the last ones sit behind the bottom bar »,
	// which is a control the touch user cannot finish using and which no markup assertion can see.
	// The figures are compared to each other rather than to a literal, so a navigation that changes
	// height cannot silently invalidate this.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/import');
	const created = [await makeAccount(page, 'BP 390 un'), await makeAccount(page, 'BP 390 deux')];
	await page.goto('/import');

	const form = page.locator('form[method="POST"]').nth(1);
	await offerAFile(page, form);

	const question = page.getByTestId('import-account-question').nth(1);
	await expect(question).toBeVisible();
	await question.locator('button').first().click();

	const panel = await page.getByTestId('account-panel').nth(1).boundingBox();
	const nav = await page.locator('nav').last().boundingBox();
	expect(panel).not.toBeNull();
	expect(nav).not.toBeNull();
	expect(panel!.y + panel!.height).toBeLessThanOrEqual(nav!.y);

	await archiveAccounts(page, created);
});
