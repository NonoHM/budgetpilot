import { DatabaseSync } from 'node:sqlite';
import { request as apiRequest, type APIRequestContext } from '@playwright/test';
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

test.use({ viewport: { width: 390, height: 844 } });

test('a wrong password keeps the revoke dialog open with the refusal focused, the right one revokes', async ({
	page
}) => {
	const second = await secondSession();
	const sessionId = newestSessionId();
	try {
		expect(await settingsStatus(second)).toBe(200);

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
	} finally {
		await second.dispose();
	}
});

test('a wrong password keeps the restore dialog open, its file still chosen', async ({ page }) => {
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
