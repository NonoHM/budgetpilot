import { expect, test } from './fixtures';
import { E2E_BOOTSTRAP_ADMIN_EMAIL, E2E_BOOTSTRAP_ADMIN_PASSWORD } from './seed';
import { expectPrimaryUnobstructed, onScreen } from './screen-geometry';
import * as m from '../src/lib/paraglide/messages';

/**
 * #986: the instance-wide AI kill switch, as an admin meets it on /admin. The journey is the one an
 * incident asks for: find the control, halt, see the page say who halted and when, and resume only
 * with the password. The engine's side (the abort, the restart, the log lines) is
 * `src/lib/server/ai/inferenceHalt.db-smoke.ts`; this is whether a person can do it.
 *
 * Ends resumed, because the suite shares one database (`e2e/` runs `workers: 1`): a halt left behind
 * would be the next spec's starting state.
 */

const halt = new RegExp(`^${m.admin_ai_halt()}$`);
const resume = new RegExp(`^${m.admin_ai_resume()}$`);

/** The state badge, and not the success banner beside it, which is also a `status` (brick 8). */
function state(page: import('@playwright/test').Page) {
	const either = `^\\s*(${m.admin_ai_state_running()}|${m.admin_ai_state_halted()})\\s*$`;
	return page
		.getByRole('status')
		.filter({ visible: true })
		.filter({ hasText: new RegExp(either) });
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 }
]) {
	test.describe(`admin AI halt at ${viewport.width}`, () => {
		test.use({ storageState: { cookies: [], origins: [] }, viewport });

		test.beforeEach(async ({ page }) => {
			await page.goto('/login');
			await page.getByLabel(m.login_email_label()).fill(E2E_BOOTSTRAP_ADMIN_EMAIL);
			await page
				.getByRole('textbox', { name: m.login_password_label(), exact: false })
				.fill(E2E_BOOTSTRAP_ADMIN_PASSWORD);
			await page.getByRole('button', { name: m.login_submit() }).click();
			await expect(page).not.toHaveURL(/\/login/);
		});

		test('halts AI, names who halted, refuses a resume without the password, resumes with it', async ({
			page
		}) => {
			await page.goto('/admin');
			await expect(state(page)).toHaveText(m.admin_ai_state_running());

			const haltButton = page.getByRole('button', { name: halt });
			await haltButton.scrollIntoViewIfNeeded();
			await expectPrimaryUnobstructed(page, halt);
			await haltButton.click();

			await expect(onScreen(page, m.admin_ai_halted_notice())).toBeVisible();
			await expect(state(page)).toHaveText(m.admin_ai_state_halted());
			// The sentence whole, not a fragment of it: the email and the « on » join are the reading.
			const haltedBy = page
				.locator('p')
				.filter({ visible: true })
				.filter({ hasText: E2E_BOOTSTRAP_ADMIN_EMAIL })
				.filter({ hasText: /\d{2}:\d{2}/ });
			await expect(haltedBy).toHaveCount(1);
			const sentence = (await haltedBy.textContent())?.trim() ?? '';
			const date = sentence.match(/\d{2}\/\d{2}\/\d{4}.*\d{2}:\d{2}/)?.[0] ?? '';
			expect(sentence).toBe(m.admin_ai_halted_by({ email: E2E_BOOTSTRAP_ADMIN_EMAIL, date }));

			const resumeButton = page.getByRole('button', { name: resume });
			await resumeButton.scrollIntoViewIfNeeded();
			await expectPrimaryUnobstructed(page, resume);
			await resumeButton.click();

			let dialog = page.getByRole('dialog', { name: m.admin_ai_resume_confirm_title() });
			await dialog.getByLabel(m.settings_delete_confirm_password_label()).fill('not-the-password');
			await dialog.getByRole('button', { name: resume }).click();
			await expect(onScreen(page, m.reauth_error_password())).toBeVisible();
			await expect(state(page)).toHaveText(m.admin_ai_state_halted());

			await page.getByRole('button', { name: resume }).click();
			dialog = page.getByRole('dialog', { name: m.admin_ai_resume_confirm_title() });
			await dialog
				.getByLabel(m.settings_delete_confirm_password_label())
				.fill(E2E_BOOTSTRAP_ADMIN_PASSWORD);
			await dialog.getByRole('button', { name: resume }).click();

			await expect(onScreen(page, m.admin_ai_resumed_notice())).toBeVisible();
			await expect(state(page)).toHaveText(m.admin_ai_state_running());
		});
	});
}
