// The detail panel is supposed to still be there after one of its forms posts, and this is the
// only level that can say so. A component spec renders the panel with a `selected` already set; it
// cannot observe what the submit does to the URL, and the URL is the whole defect.
//
// Measured before the fix, at both widths, from
// `?q=CARREFOUR+MARKET&page=1&selected=<id>` with the detail open: the address bar became
// `/transactions?/saveManualNature`, no detail panel remained in the DOM at either width, the
// search field was empty, the tab was back on « Toutes » and the list had gone from the one
// matching row to every row. The save itself had worked. Nothing on screen said so, and nothing
// on screen would have said so if it had been refused either, which is what the third case here
// is about.
//
// The suite shares one database in declaration order, so this file creates the two rows it needs
// and deletes both afterwards.
import { request, type APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';
import { E2E_API_HEADERS, E2E_BASE_URL } from './config';
import { assertOk, createTransaction, loginE2eUser, submitForm } from './seed';
import * as m from '../src/lib/paraglide/messages';

const STATE_LABEL = 'E2E PANEL STATE';
const REFUSAL_LABEL = 'E2E PANEL REFUSAL';
const DATE = '2026-09-14';
const CATEGORY = 'Alimentation';
/** A category the seed owns that the fixture row is NOT in, so picking it is a real change. */
const OTHER_CATEGORY = 'Transport';
const PENDING_TAG = 'E2E PANEL PENDING';

let api: APIRequestContext;
const ids = new Map<string, string>();

/** The row's "select this transaction" link carries `selected=<id>`, HTML-entity-encoded by SSR. */
async function resolveTransactionId(label: string): Promise<string> {
	const html = await (await api.get(`/transactions?q=${encodeURIComponent(label)}`)).text();
	const match = html.match(/[?&](?:amp;)?selected=([A-Za-z0-9_-]+)/);
	if (!match) throw new Error(`could not resolve a transaction id for label "${label}"`);
	return match[1];
}

test.beforeAll(async () => {
	api = await request.newContext({ baseURL: E2E_BASE_URL, extraHTTPHeaders: E2E_API_HEADERS });
	await loginE2eUser(api);
	for (const label of [STATE_LABEL, REFUSAL_LABEL]) {
		await createTransaction(api, { date: DATE, label, amount: '-12.34', category: CATEGORY });
		ids.set(label, await resolveTransactionId(label));
	}
});

test.afterAll(async () => {
	for (const id of ids.values()) {
		// `assertOk`, like every other caller of `submitForm` in this suite. A cleanup that fails
		// silently leaves rows in a database `workers: 1` shares with every later spec file, and the
		// failure then surfaces somewhere else entirely as a count that is off by two.
		assertOk(
			'deleteTransaction cleanup',
			await submitForm(api, '/transactions?/deleteTransaction', { transactionId: id })
		);
	}
	await api.dispose();
});

/** Opens the detail on `label` through a filtered list, and returns the URL that produced it. */
async function openFilteredSelection(page: import('@playwright/test').Page, label: string) {
	await page.goto(`/transactions?q=${encodeURIComponent(label)}&qMode=contains`);
	await page
		.getByRole('link', { name: new RegExp(label) })
		.first()
		.click();
	await expect(page).toHaveURL(/selected=/);
	return new URL(page.url());
}

/** The nature form on the surface that is actually visible at the current width. */
function visibleNatureForm(page: import('@playwright/test').Page) {
	return page.locator('form[action*="/saveManualNature"]').filter({ visible: true });
}

async function chooseNature(page: import('@playwright/test').Page, natureLabel: string) {
	const form = visibleNatureForm(page);
	await expect(form).toHaveCount(1);
	await form.getByRole('button', { name: m.transactions_manual_nature_heading() }).click();
	await page.getByRole('option', { name: natureLabel }).first().click();
	await form.getByRole('button', { name: m.common_save(), exact: true }).click();
}

for (const width of [
	{ name: 'desktop', size: { width: 1280, height: 900 }, nature: m.nature_transfer() },
	{ name: 'mobile', size: { width: 390, height: 844 }, nature: m.nature_refund() }
]) {
	test(`${width.name}: saving a nature keeps the selection, the filter and the panel`, async ({
		page
	}) => {
		await page.setViewportSize(width.size);
		const before = await openFilteredSelection(page, STATE_LABEL);

		// Separates the two halves of the fix, which the assertions below cannot: the action URL alone
		// would satisfy every one of them while still doing a full page load, because it carries the
		// selection and the filters THROUGH that load. This marker does not survive one.
		await page.evaluate(() => {
			(window as unknown as { __beforeSave?: number }).__beforeSave = 1;
		});

		await chooseNature(page, width.nature);
		// Waited on a real observable state rather than read synchronously: `enhance` fetches the
		// action and re-runs the load, so the Save button going inactive is the first moment the
		// page has answered.
		await expect(
			visibleNatureForm(page).getByRole('button', { name: m.common_save(), exact: true })
		).toBeDisabled();

		expect(
			await page.evaluate(() => (window as unknown as { __beforeSave?: number }).__beforeSave)
		).toBe(1);

		// The three things the submit used to discard, asserted from the URL the panel is built from.
		const after = new URL(page.url());
		expect(after.searchParams.get('selected')).toBe(before.searchParams.get('selected'));
		expect(after.searchParams.get('q')).toBe(STATE_LABEL);
		expect(after.searchParams.get('page')).toBe(before.searchParams.get('page'));

		// And the panel itself, which is what the URL was carrying the selection FOR.
		await expect(visibleNatureForm(page)).toHaveCount(1);
		// The list is still the filtered one: one row, not the whole history.
		await expect(page.getByRole('link', { name: new RegExp(STATE_LABEL) })).toHaveCount(1);
	});
}

test('a refused save says why, in the panel it was refused in', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await openFilteredSelection(page, REFUSAL_LABEL);

	// The refusal these forms can actually produce, and every one of them has this shape: the row
	// or its category changes between the panel rendering and the submit. Reproduced here through a
	// second session rather than simulated, because a panel left open in one tab while the row is
	// deleted in another is exactly the situation.
	const id = ids.get(REFUSAL_LABEL) as string;
	assertOk(
		'deleteTransaction from the second session',
		await submitForm(api, '/transactions?/deleteTransaction', { transactionId: id })
	);
	ids.delete(REFUSAL_LABEL);

	await chooseNature(page, m.nature_transfer());

	// The sentence, not merely that something went red: a test on a refusal asserts the REASON.
	const alert = visibleNatureForm(page).getByRole('alert');
	await expect(alert).toContainText(m.transactions_error_transaction_not_found());
	// Announced where it belongs. Before the fix this sentence was computed, returned to the page,
	// and rendered nowhere, because the only place that renders it is the panel the submit removed.
	await expect(visibleNatureForm(page)).toHaveCount(1);
	expect(new URL(page.url()).searchParams.get('selected')).toBe(id);
});

test('a save does not discard the editor beside it', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await openFilteredSelection(page, STATE_LABEL);

	// Three kinds of work in the panel, none of them saved, none of them belonging to the form that
	// is about to be submitted. Before this they all went: `use:enhance` re-runs the load, and every
	// editor on the page reset itself off the fresh object as if a different row had been selected.
	const categoryForm = page
		.locator('form[action*="/saveManualCategory"]')
		.filter({ visible: true });
	await categoryForm.locator(`button[aria-label="${m.common_combobox_open_list_aria()}"]`).click();
	await page.getByRole('option', { name: OTHER_CATEGORY, exact: true }).first().click();
	// Read off the hidden input, which is the value a submit would actually carry, and asserted here
	// as well as at the end: an assertion that only checks the after cannot tell "it survived" from
	// "it was never picked".
	const pendingCategory = categoryForm.locator('input[name="manualCategory"]');
	await expect(pendingCategory).toHaveValue(OTHER_CATEGORY);

	const tagsForm = page.locator('form[action*="/saveTags"]').filter({ visible: true });
	await tagsForm.getByRole('combobox').click();
	await page.keyboard.type(PENDING_TAG);
	const createRow = page.getByRole('option').filter({ hasText: PENDING_TAG }).first();
	await expect(createRow).toBeVisible();
	await createRow.click();
	const chip = tagsForm.getByRole('button', { name: m.tags_remove_aria({ name: PENDING_TAG }) });
	await expect(chip).toBeVisible();

	const accordion = page
		.getByRole('button', { name: m.transactions_bank_details_heading() })
		.first();
	await accordion.click();
	await expect(accordion).toHaveAttribute('aria-expanded', 'true');

	// Now save a FOURTH thing: the nature.
	await chooseNature(page, m.nature_transfer());
	await expect(
		visibleNatureForm(page).getByRole('button', { name: m.common_save(), exact: true })
	).toBeDisabled();

	// All three survive. The saved form re-baselined; the three beside it were not touched.
	await expect(chip).toBeVisible();
	await expect(accordion).toHaveAttribute('aria-expanded', 'true');
	await expect(pendingCategory).toHaveValue(OTHER_CATEGORY);
});
