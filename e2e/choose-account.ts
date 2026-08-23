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

	const option = page.getByRole('option').first();
	await expect(option).toBeVisible();
	const name = (await option.getAttribute('aria-label')) ?? '';
	await option.click();

	// The row now STATES an account. Asserted rather than assumed: a click that chose nothing would
	// otherwise be discovered by the next assertion in whatever spec called this.
	await expect(page.getByRole('button', { name: /^Compte, / })).toBeVisible();
	return name;
}
