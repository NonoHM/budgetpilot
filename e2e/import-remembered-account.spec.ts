import { request as apiRequest, type Page } from '@playwright/test';
import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';
import { E2E_API_HEADERS, E2E_BASE_URL, E2E_LOCALE } from './config';
import {
	E2E_BOOTSTRAP_ADMIN_EMAIL,
	E2E_BOOTSTRAP_ADMIN_PASSWORD,
	assertOk,
	submitForm
} from './seed';

/**
 * #599, #696: THE REMEMBERED ACCOUNT, AS A USER MEETS IT, from the upload to « Oublier ».
 *
 * A statement names account ···0185; the user holds one account, which carries ···4417. The import
 * asks, the user answers, the SAME statement uploaded again arrives with the answer pre-filled and
 * « Mémorisé, 1 import depuis le … », Settings lists it, « Oublier » removes it, and the next upload
 * asks again. Every step is asserted on the sentence the user reads, compared whole.
 *
 * ITS OWN USER, registered by the bootstrap admin, because this journey creates an account and a
 * memory: on the shared e2e user, a statement account created here changed what later import specs
 * saw (recorded when a spec that created an Account broke later ones). A second user leaves the
 * shared one exactly as the seed made it.
 *
 * Synthetic data, inline: holder Paul Mercier, account numbers that belong to nobody.
 *
 * `BP_E2E_SHOTS_DIR`, when set, receives a screenshot of each state at 390 and 1280; unset in CI.
 */

const USER = {
	email: `p1-memory-${Date.now()}@example.test`,
	password: 'P1-Memory-Journey-2026!'
};

function statement(identifier: string): string {
	return [
		'dateOp;dateVal;label;category;categoryParent;supplierFound;amount;comment;accountNum;accountLabel;accountbalance',
		`2026-08-03;2026-08-03;CARTE MERCERIE LAFAYETTE;Alimentation;Vie quotidienne;;-45,20;;${identifier};CCJ;1500,00`,
		`2026-08-14;2026-08-14;VIR SALAIRE PAUL MERCIER;Revenus;Revenus;;1850,00;;${identifier};CCJ;3350,00`
	].join('\n');
}

const HELD = '00012344417';
const NAMED = '00012340185';

/** « 30 septembre », as the page formats the day the answer was given (`accountMemoryLabel`). */
const today = () =>
	new Intl.DateTimeFormat(E2E_LOCALE, { day: 'numeric', month: 'long' }).format(new Date());

async function shoot(page: Page, name: string) {
	const dir = process.env.BP_E2E_SHOTS_DIR;
	if (!dir) return;
	const size = page.viewportSize();
	for (const [width, height] of [
		[390, 844],
		[1280, 800]
	]) {
		await page.setViewportSize({ width, height });
		await page.screenshot({ path: `${dir}/e2e-${name}-${width}.png`, fullPage: true });
	}
	if (size) await page.setViewportSize(size);
}

async function upload(page: Page) {
	await page.goto('/import');
	const form = page.locator('form[method="POST"]').first();
	await form.locator('input[name="csvFile"]').setInputFiles({
		name: 'releve-0185.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(statement(NAMED), 'utf-8')
	});
	await form.getByRole('button', { name: m.import_submit() }).click();
	return form;
}

test('an answered account is remembered, shown, forgotten, and asked again', async ({
	browser
}) => {
	// The user, and their one account holding ···4417, through the production routes.
	const admin = await apiRequest.newContext({
		baseURL: E2E_BASE_URL,
		extraHTTPHeaders: E2E_API_HEADERS,
		storageState: { cookies: [], origins: [] }
	});
	assertOk(
		'admin login',
		await submitForm(admin, '/login', {
			email: E2E_BOOTSTRAP_ADMIN_EMAIL,
			password: E2E_BOOTSTRAP_ADMIN_PASSWORD
		})
	);
	assertOk('register journey user', await submitForm(admin, '/register', USER));
	await admin.dispose();

	const api = await apiRequest.newContext({
		baseURL: E2E_BASE_URL,
		extraHTTPHeaders: E2E_API_HEADERS,
		storageState: { cookies: [], origins: [] }
	});
	assertOk('journey user login', await submitForm(api, '/login', USER));
	const created = await api.post('/import/accounts', {
		multipart: {
			name: 'Compte courant',
			csvFile: { name: 'releve.csv', mimeType: 'text/csv', buffer: Buffer.from(statement(HELD)) }
		}
	});
	expect(created.status()).toBe(200);

	const context = await browser.newContext({
		storageState: await api.storageState(),
		viewport: { width: 1280, height: 800 }
	});
	await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: E2E_LOCALE, url: E2E_BASE_URL }]);
	await api.dispose();
	const page = await context.newPage();
	const question = page.getByTestId('import-account-question').first();

	// 1. The file names ···0185, which the one account does not hold: ASKED, with the row's own
	//    sentence (the user holds one account, so « plusieurs comptes » would be false).
	const form = await upload(page);
	await expect(
		page.getByText(m.import_account_error_required(), { exact: true }).first()
	).toBeVisible();
	await expect(question.locator('button').first()).toHaveText(m.import_account_row_placeholder());
	await shoot(page, '1-asked');

	// 2. The answer imports, and the summary names the account.
	await question.locator('button').first().click();
	await page
		.getByRole('option', { name: /Compte courant/ })
		.first()
		.click();
	await form.getByRole('button', { name: m.import_submit() }).click();
	await expect(
		page
			.getByText(m.imports_success_into_account({ count: 2, account: 'Compte courant' }), {
				exact: true
			})
			.first()
	).toBeVisible({ timeout: 15_000 });

	// 3. The SAME statement again: the row arrives answered, saying why, and the banner asking to
	//    choose is gone (the hint explains the pre-fill).
	await upload(page);
	await expect(question.locator('button').first()).toHaveAccessibleName(
		m.import_account_row_aria({ account: 'Compte courant' })
	);
	await expect(
		question.getByText(m.import_account_hint_from_memory_one({ count: 1, date: today() }), {
			exact: true
		})
	).toBeVisible();
	await expect(page.getByText(m.import_account_error_required(), { exact: true })).toHaveCount(0);
	await shoot(page, '2-remembered');

	// 4. Settings lists it, by its last four and the account's name.
	await page.goto('/settings');
	const card = page.locator('#remembered-accounts');
	const row = card.locator('li').first();
	await expect(row.locator('p').first()).toHaveText('···0185 Compte courant');
	await expect(row.locator('p').nth(1)).toHaveText(
		`${m.settings_remembered_accounts_remembered_on({ date: today() })} · ${m.settings_remembered_accounts_used_one({ count: 1 })}`
	);
	await row.scrollIntoViewIfNeeded();
	await shoot(page, '3-settings');

	// 5. « Oublier », confirmed: the empty state says when one is remembered.
	await card
		.getByRole('button', { name: m.settings_remembered_accounts_forget_aria({ fragment: '0185' }) })
		.click();
	const dialog = page.getByRole('dialog');
	await expect(
		dialog.getByText(m.settings_remembered_accounts_confirm_body(), { exact: true })
	).toBeVisible();
	await dialog.getByRole('button', { name: m.settings_mappings_forget() }).click();
	await expect(
		card.getByText(m.settings_remembered_accounts_empty(), { exact: true })
	).toBeVisible();
	await shoot(page, '4-forgotten');

	// 6. The same statement asks again, nothing pre-filled.
	await upload(page);
	await expect(
		page.getByText(m.import_account_error_required(), { exact: true }).first()
	).toBeVisible();
	await expect(question.locator('button').first()).toHaveText(m.import_account_row_placeholder());
	await shoot(page, '5-asked-again');

	await context.close();
});
