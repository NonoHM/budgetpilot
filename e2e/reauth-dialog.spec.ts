import { DatabaseSync } from 'node:sqlite';
import { request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { E2E_API_HEADERS, E2E_BASE_URL } from './config';
import { assertOk, E2E_USER_EMAIL, E2E_USER_PASSWORD, submitForm } from './seed';
import * as m from '../src/lib/paraglide/messages';

/**
 * A refused re-authentication is answered INSIDE the dialog that asked (#253, #228, Planche 5f).
 *
 * Measured before this spec, at 390 px on the build: a wrong password in the revoke dialog was a
 * native POST that reloaded the page at the top, closed the dialog and rendered the only sentence
 * at y 1294, below the fold, with the focus on the body; the restore dialog did the same at y 2644
 * and lost the chosen file. A wrong password read as a press that did nothing.
 *
 * Each test separates « the answer is where the press was » (dialog still open, the sentence
 * focused inside it) from « the page reloaded elsewhere » (dialog gone). The revoke test then
 * completes the journey and observes the outcome OUTSIDE the page: the revoked session's own
 * requests are sent to /login, which no rendering of /settings can fake.
 *
 * #249: the same journey carries the rotation. A copy of the page's cookie, taken before the
 * re-authentication, is sent to /login after it, while the page stays signed in. That separates
 * « the token the request arrived with ended » from « the browser was given a new one and the old
 * one still works » (main, measured: one live session still carried it).
 *
 * EACH TEST SIGNS IN ON ITS OWN SESSION. A successful re-authentication rotates the token, so
 * running one on the suite's shared `storageState` session would leave the saved file holding a
 * dead cookie, and every spec after this one would start signed out.
 */

const SESSION_DB = 'e2e/.data/test.db';

/** The id of the newest session of the e2e user, read from the database the app writes. */
function newestSessionId(): string {
	const db = new DatabaseSync(SESSION_DB, { readOnly: true });
	try {
		const row = db
			.prepare(
				'SELECT s.id AS id FROM "Session" s JOIN "User" u ON u.id = s."userId" WHERE u.email = ? ORDER BY s."createdAt" DESC LIMIT 1'
			)
			.get(E2E_USER_EMAIL) as { id: string } | undefined;
		if (!row) throw new Error('newestSessionId: the e2e user has no session');
		return row.id;
	} finally {
		db.close();
	}
}

async function secondSession(): Promise<APIRequestContext> {
	const context = await apiRequest.newContext({
		baseURL: E2E_BASE_URL,
		extraHTTPHeaders: E2E_API_HEADERS,
		storageState: { cookies: [], origins: [] }
	});
	assertOk(
		'second login',
		await submitForm(context, '/login', {
			email: E2E_USER_EMAIL,
			password: E2E_USER_PASSWORD
		})
	);
	return context;
}

/** 200 while the session lives, a redirect to /login once it is revoked. */
async function settingsStatus(context: APIRequestContext): Promise<number> {
	return (await context.get('/settings', { maxRedirects: 0 })).status();
}

test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 } });

/** The page signs in through the form, so the session it holds is its own. */
async function signIn(page: Page): Promise<void> {
	await page.goto('/login');
	await page.getByLabel(m.login_email_label()).fill(E2E_USER_EMAIL);
	await page
		.getByRole('textbox', { name: m.login_password_label(), exact: false })
		.fill(E2E_USER_PASSWORD);
	await page.getByRole('button', { name: m.login_submit() }).click();
	await expect(page).not.toHaveURL(/\/login/);
}

/** Another holder of the page's cookie as it stands now: a copy taken by whoever read it. */
async function copyOfCookie(page: Page): Promise<APIRequestContext> {
	return apiRequest.newContext({
		baseURL: E2E_BASE_URL,
		extraHTTPHeaders: E2E_API_HEADERS,
		storageState: await page.context().storageState()
	});
}

test('a wrong password keeps the revoke dialog open with the refusal focused, the right one revokes', async ({
	page
}) => {
	const second = await secondSession();
	const sessionId = newestSessionId();
	await signIn(page);
	const copy = await copyOfCookie(page);
	try {
		expect(await settingsStatus(second)).toBe(200);
		expect(await settingsStatus(copy)).toBe(200);

		await page.goto('/settings');
		await page.locator(`button[data-session-id="${sessionId}"]:visible`).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();

		await dialog.getByLabel(m.settings_delete_confirm_password_label()).fill('not-the-password');
		await dialog.getByRole('button', { name: m.settings_revoke_session() }).click();

		const refusal = dialog.getByRole('alert');
		await expect(refusal).toHaveText(m.reauth_error_password());
		await expect(refusal).toBeFocused();
		expect(await settingsStatus(second)).toBe(200);
		// A refusal rotates nothing: the copy still works.
		expect(await settingsStatus(copy)).toBe(200);

		// The retry empties the refused password and puts the person back in the field.
		await dialog.getByRole('button', { name: m.common_retry() }).click();
		const password = dialog.getByLabel(m.settings_delete_confirm_password_label());
		await expect(password).toBeFocused();
		await expect(password).toHaveValue('');

		await password.fill(E2E_USER_PASSWORD);
		await dialog.getByRole('button', { name: m.settings_revoke_session() }).click();
		await expect(dialog).toBeHidden();
		await expect(page.locator(`button[data-session-id="${sessionId}"]`)).toHaveCount(0);
		expect(await settingsStatus(second)).toBe(303);
		// #249: the token the page re-authenticated with is over, for every copy of it...
		expect(await settingsStatus(copy)).toBe(303);
		// ...and the page itself holds the new one and is still signed in.
		await page.goto('/settings');
		await expect(page).toHaveURL(/\/settings$/);
	} finally {
		await second.dispose();
		await copy.dispose();
	}
});

test('a wrong password keeps the restore dialog open, its file still chosen', async ({ page }) => {
	await signIn(page);
	await page.goto('/settings');
	// The section's own toggle: its row is the title's grandparent (title, its wrapper, the row).
	await page
		.getByText(m.settings_restore_title(), { exact: true })
		.locator('xpath=../..')
		.getByRole('button', { name: m.settings_toggle_show() })
		.click();
	await page.locator('input[name="backupFile"]').setInputFiles({
		name: 'backup.json',
		mimeType: 'application/json',
		buffer: Buffer.from('{"version":1}')
	});
	await page
		.getByRole('button', { name: m.settings_restore_submit() })
		.filter({ visible: true })
		.click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel(m.settings_delete_confirm_password_label()).fill('not-the-password');
	await dialog.getByRole('button', { name: m.settings_restore_submit() }).click();

	const refusal = dialog.getByRole('alert');
	await expect(refusal).toHaveText(m.reauth_error_password());
	await expect(refusal).toBeFocused();
	// The file survives the refusal, so a retry does not mean choosing it again.
	expect(
		await page
			.locator('input[name="backupFile"]')
			.evaluate((input: HTMLInputElement) => input.files?.length)
	).toBe(1);
});
