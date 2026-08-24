import { expect, type Page } from '@playwright/test';
import * as m from '../src/lib/paraglide/messages';

/**
 * Chooses the account a statement belongs to, on the designation screen.
 *
 * ## Why every designation journey needs this now
 *
 * The account is a first-class choice as of the statement-account piece, and the primary refuses a
 * submission without one: pressing it reveals the error, scrolls the row into view and puts focus
 * on it, rather than greying itself out. So a spec that presses « Importer » without coming through
 * here does not fail with a wrong figure, it simply STAYS ON THE SCREEN — which surfaces as a URL
 * assertion timing out fifteen seconds later and reads like a hang.
 *
 * That is exactly how these six specs failed the first time this ran, and it is why this helper
 * asserts the row reached its `ok` state instead of just clicking: a silent no-op here would push
 * the failure into whatever the spec asserts next, one screen away from its cause.
 *
 * ## It takes the FIRST option deliberately
 *
 * No spec in this suite has more than one statement account at the point it designates, and the
 * ones that will are the ones testing the choice itself. Naming an account here instead would make
 * every journey depend on a fixture it does not otherwise care about.
 */
export async function chooseStatementAccount(page: Page): Promise<string> {
	const row = page.getByRole('button', { name: new RegExp(`^${m.import_account_row_label()},`) });
	// The row before a choice carries the placeholder, not an account, so it is found by its label.
	const trigger = (await row.count()) > 0 ? row : page.getByRole('button', { name: /^Compte/ });
	await trigger.first().click();

	/**
	 * THE EMPTY PANEL IS A REAL JOURNEY, not a fixture gap, so it is walked rather than avoided.
	 *
	 * A user whose only `Account` row is the manual bucket has no statement account at all:
	 * `isStatementAccount` excludes it, so the panel's only content is « Nouveau compte ». Before the
	 * create sheet existed that user could not finish an import from this screen at any price, and
	 * this helper hung for fifteen seconds waiting for an option that could never appear.
	 *
	 * Creating one HERE rather than seeding one in a fixture is the deliberate choice: it is the
	 * path a first-time user takes, it is the only path that exercises the sheet end to end in a
	 * real browser, and a seeded account would make every journey silently skip the cell the whole
	 * task exists for.
	 */
	const option = page.getByRole('option').first();
	if ((await option.count()) === 0) {
		await page.getByRole('button', { name: m.import_account_new() }).click();
		const field = page.getByRole('textbox', { name: m.import_account_create_field() });
		await expect(field).toBeVisible();
		// A name unique per worker, because two workers designating at once are two users and a
		// collision here would refuse the second for a reason about the first.
		const created = `Compte e2e ${process.env.TEST_WORKER_INDEX ?? '0'}`;
		await field.fill(created);
		await page.getByRole('button', { name: m.import_account_create_submit() }).click();
		// The ROW states it, which is the same assertion the ordinary path makes below.
		await expect(page.getByRole('button', { name: /^Compte, / })).toBeVisible();
		return created;
	}
	await expect(option).toBeVisible();
	const name = (await option.getAttribute('aria-label')) ?? '';
	await option.click();

	// The row now STATES an account. Asserted rather than assumed: a click that chose nothing would
	// otherwise be discovered by the next assertion in whatever spec called this.
	await expect(page.getByRole('button', { name: /^Compte, / })).toBeVisible();
	return name;
}
