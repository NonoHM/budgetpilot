// A répartition save that FAILS must look nothing like one that succeeded (design 1i).
//
// THE DEFECT THIS PINS, measured 2026-08-09 in a real browser against a production build on a real
// database, before any of it was written. Delete the session row, fill the editor, press
// « Enregistrer ». The POST answers HTTP 200 carrying
// `{"type":"redirect","status":303,"location":"/login?redirectTo=…"}` — SvelteKit turns the
// redirect the auth hook threw into an action result, so the 303 is a field in a JSON body rather
// than a status on the wire. `use:enhance`'s `update()` handed that to `applyAction`, which called
// `goto('/login?…')`, and this page's own unsaved-changes guard cancelled it — the editor is dirty
// by construction whenever Save can be pressed at all, since `canSave` requires `isDirty`. What the
// user got was « Abandonner les modifications ? », the generic unsaved-work prompt: it never said
// the save had failed, never said why, and its « Abandonner » discarded the parts and left for
// /login. Its « Rester » returned a screen identical to a successful save minus the success banner
// — the data-loss shape, since the user believes their répartition is stored.
//
// WHY THE TWO HALVES ARE IN THIS ORDER. CLAUDE.md's appear-then-disappear rule: an assertion that
// something is absent proves nothing unless the thing has been seen to be present. So the success
// banner is proven to appear first, on a real save, and only then asserted absent on the failure —
// otherwise "no success banner" would pass on an empty DOM, on an unmounted component, or on a
// page that never rendered at all.
//
// HOW THE SESSION IS INVALIDATED, and why it is not a DELETE against the file. Replacing the
// session cookie with a token that resolves to no session reaches the SAME branch of
// `handleAuth`: `readSessionUser` returns null for a token that is present, so the hook clears the
// cookie and throws the 303. It needs no second process writing to the database the server has
// open, and nothing to restore — Playwright builds each test its own context from `storageState`,
// so the next spec's session is untouched. The cookie is asserted to EXIST before it is
// overwritten, which is what turns a renamed cookie into a red test instead of a silent no-op.
//
// The spec RESTORES the transaction it splits: the suite shares one database in declaration order,
// so a répartie row left behind would change the classify pile and the Répartition filter for
// every spec after it. The failure half writes nothing by construction, which is the point.
import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

/** Seeded by `e2e/seed.ts` at −18,50 € on Transport, and left alone by every other spec. */
const LABEL = 'SNCF CONNECT PARIS';
const PART_ONE = '12,50';
const PART_TWO = '6,00';
/** The category part 2 is moved to — anything other than the parent's, so the split is real. */
const PART_TWO_CATEGORY = 'Alimentation';

/**
 * `SESSION_COOKIE` in `src/lib/server/auth.ts`. Restated rather than imported: that module pulls in
 * Prisma, and a Playwright node process has no business loading the server's database client. The
 * `expect` on its presence below is what keeps the restatement honest — a rename makes this spec
 * fail by name instead of quietly poisoning nothing.
 */
const SESSION_COOKIE = 'budgetpilot_session';

function splitForm(page: import('@playwright/test').Page) {
	// The desktop `<aside>`, at a desktop viewport: the mobile sheet is mounted at every breakpoint
	// and only hidden by CSS, so an unscoped locator matches two copies of every control.
	return page.locator('aside').locator('form[action*="/saveSplits"]').first();
}

async function removeAnyExistingSplit(page: import('@playwright/test').Page) {
	const remove = page.getByRole('button', { name: m.splits_remove_action() }).first();
	if (!(await remove.isVisible().catch(() => false))) return;
	await remove.click();
	await splitForm(page).getByRole('button', { name: m.common_save() }).click();
	await expect(page.getByRole('button', { name: m.splits_entry_action() }).first()).toBeVisible();
}

/** Opens the editor on an unsplit transaction and fills it to the point where Save is available. */
async function fillEditor(page: import('@playwright/test').Page) {
	await page.getByRole('button', { name: m.splits_entry_action() }).first().click();
	const editor = splitForm(page);
	await expect(editor).toBeVisible();

	await editor.getByLabel(m.splits_part_amount_aria({ position: 1 })).fill(PART_ONE);
	await editor.getByLabel(m.splits_part_amount_aria({ position: 2 })).fill(PART_TWO);
	// Opened through the row's own trigger rather than by clicking the field: bits-ui's combobox
	// opens from the chevron, and the page carries several of those triggers at once — the
	// wrapper's `data-split-category` is what disambiguates.
	await editor
		.locator(`[data-split-category="2"] button[aria-label="${m.common_combobox_open_list_aria()}"]`)
		.click();
	await page.getByRole('option', { name: PART_TWO_CATEGORY }).first().click();

	const save = editor.getByRole('button', { name: m.common_save() });
	await expect(save).not.toHaveAttribute('aria-disabled', 'true');
	return { editor, save };
}

test.describe('a répartition save that fails (1i)', () => {
	test('says so, keeps the parts on screen, and is not mistakable for a success', async ({
		page
	}) => {
		test.slow();
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/transactions');
		await page
			.getByRole('link', { name: new RegExp(LABEL) })
			.first()
			.click();
		// Idempotent by construction: this suite retries twice on one shared database, so a run that
		// fails after the save would otherwise leave the transaction répartie and make the retry fail
		// on the missing entry row instead of on whatever broke.
		await removeAnyExistingSplit(page);

		// ---- FIRST, the success path, so presence is proven possible ---------------------------
		{
			const { editor, save } = await fillEditor(page);
			await save.click();

			const success = page.locator('aside').getByText(m.splits_success_saved({ count: 2 }));
			await expect(success).toBeVisible();
			// The parts survive the save as WRITTEN values, not as a draft: the editor is remounted
			// against the saved parts, so reading them back is a statement about the database.
			await expect(editor.getByLabel(m.splits_part_amount_aria({ position: 1 }))).toHaveValue(
				PART_ONE
			);
			await expect(editor.getByLabel(m.splits_part_amount_aria({ position: 2 }))).toHaveValue(
				PART_TWO
			);
		}

		// Back to unsplit BEFORE the session is invalidated — after it, this page can write nothing.
		await removeAnyExistingSplit(page);

		// ---- THEN the failure path ---------------------------------------------------------------
		const { editor, save } = await fillEditor(page);

		const context = page.context();
		const before = (await context.cookies()).find((cookie) => cookie.name === SESSION_COOKIE);
		expect(
			before,
			`no ${SESSION_COOKIE} cookie to invalidate — the constant no longer matches src/lib/server/auth.ts`
		).toBeTruthy();
		await context.addCookies([
			{
				name: SESSION_COOKIE,
				value: 'e2e-token-that-resolves-to-no-session',
				domain: before!.domain,
				path: before!.path
			}
		]);

		await save.click();

		// (a) the failure is stated, inside the panel, as an alert, and it names the cause.
		const alert = page
			.locator('aside')
			.getByRole('alert')
			.filter({ hasText: m.splits_error_session_expired() })
			.first();
		await expect(alert).toBeVisible();

		// (b) the parts are STILL RENDERED, with their values. This is what the sentence promises.
		await expect(editor.getByLabel(m.splits_part_amount_aria({ position: 1 }))).toHaveValue(
			PART_ONE
		);
		await expect(editor.getByLabel(m.splits_part_amount_aria({ position: 2 }))).toHaveValue(
			PART_TWO
		);

		// (c) no success banner. Safe to assert as an absence only because the wait on (a) has
		// already established that the response was processed.
		await expect(page.locator('aside').getByText(m.splits_success_saved({ count: 2 }))).toHaveCount(
			0
		);

		// (d) the page did not leave, and the user was NOT asked « Abandonner les modifications ? »
		// — the misleading prompt this treatment replaces. Both are properties of the swallow, and
		// both go red if the redirect is handed back to `applyAction`.
		expect(new URL(page.url()).pathname).toBe('/transactions');
		await expect(page.getByText(m.transactions_unsaved_title())).toHaveCount(0);
	});
});
