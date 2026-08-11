import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

/**
 * #161, end to end and through the real UI, because the condition the fix hangs on is a RENDER.
 *
 * `applyCategoryRules` used to write `manualCategory: rule.targetCategory` verbatim, so deleting a
 * category left a rule that put the deleted name back on the next run. The engine half is pinned
 * by unit specs and by `references.db-smoke.ts` on three engines. What none of those can show is
 * the half the issue calls non-optional: a rule that silently stops firing converts a loud bug into
 * a quiet one, so the user has to be able to SEE that it is paused and why.
 *
 * Driven entirely through the pages rather than seeded, and that is the point of doing it here at
 * all: the paused state is derived at render time from the categories the load already fetched, so
 * the only honest test is to make a category disappear the way a user makes it disappear.
 *
 * SELF-CLEANING, and deliberately so. This suite runs with `workers: 1` and specs inherit each
 * other's state, so a spec that left a category or a rule behind would change what every later
 * spec sees. Everything created here is removed here, including on the assertion paths, which is
 * why the deletions are not guarded by the assertions above them.
 */
const CATEGORY = 'Cinema161';
const RULE = 'Regle Cinema161';

async function deleteRuleIfPresent(page: import('@playwright/test').Page) {
	await page.goto('/rules');
	const row = page.locator('table tbody tr').filter({ hasText: RULE });
	if ((await row.count()) === 0) return;
	await row.first().getByRole('button', { name: m.common_delete(), exact: true }).click();
	await page.getByRole('dialog').getByRole('button', { name: m.common_delete() }).click();
	await expect(page.locator('table tbody tr').filter({ hasText: RULE })).toHaveCount(0);
}

test.describe('a rule whose target category was deleted', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test.afterEach(async ({ page }) => {
		await deleteRuleIfPresent(page);
	});

	test('says it is paused, and the delete dialog warns before it happens', async ({ page }) => {
		// 1. A category of this test's own, so nothing seeded is disturbed.
		await page.goto('/categories');
		await page.getByRole('button', { name: m.categories_new() }).first().click();
		const createCategory = page.getByRole('dialog');
		await createCategory.getByRole('textbox').fill(CATEGORY);
		await createCategory.getByRole('button', { name: m.categories_create_submit() }).click();
		await expect(page.getByText(CATEGORY).first()).toBeVisible();

		// 2. A rule targeting it, created the way a user creates one: the target comes from the
		//    picker, so it necessarily names a category that exists at this point.
		await page.goto('/rules');
		await page.getByRole('button', { name: m.rules_new() }).first().click();
		const createRule = page.getByRole('dialog');
		await createRule.getByLabel(m.rules_field_name()).fill(RULE);
		// By name attribute, not by label: this field's <label> wraps BOTH the regex IconButton and
		// the input, so it names two controls and resolves to neither.
		await createRule.locator('input[name="matchText"]').fill('ugc161');
		// The target picker is a Bits UI Combobox: a chevron trigger beside a filtering input, with
		// the option list portalled to <body>, which is why the option is looked up on `page` and
		// not inside the dialog. Typing first rather than scrolling: the list holds every category
		// the user has, and this one is newly created and last alphabetically in neither locale.
		await createRule
			.getByRole('button', { name: m.common_combobox_open_list_aria() })
			.first()
			.click();
		await createRule.getByLabel(m.rules_field_target_category()).fill(CATEGORY);
		await page.getByRole('option', { name: CATEGORY, exact: true }).click();
		await createRule.getByRole('button', { name: m.rules_create_submit() }).click();

		const ruleRow = page.locator('table tbody tr').filter({ hasText: RULE });
		await expect(ruleRow).toHaveCount(1);
		// It is NOT paused yet. The absence asserted at the end is only meaningful because the
		// presence was observed first: polling for "paused is absent" on a page that had not
		// rendered would pass for the wrong reason.
		await expect(ruleRow).not.toContainText(m.rules_status_paused());
		await expect(ruleRow).toContainText(m.rules_status_active());

		// 3. The dialog states the consequence BEFORE the action. The user is thinking about
		//    transactions when they delete a category, not about a rule they wrote months ago, so
		//    this sentence is the only moment they hold both.
		await page.goto('/categories');
		const categoryRow = page.locator('table tbody tr').filter({ hasText: CATEGORY });
		await categoryRow.getByRole('button', { name: m.common_delete(), exact: true }).click();
		const confirm = page.getByRole('dialog');
		await expect(confirm).toContainText(m.categories_delete_rules_paused_one({ count: 1 }));
		await confirm.getByRole('button', { name: m.common_delete() }).click();

		// 4. The rule survived, and says why it is not working. Both halves matter: a row that had
		//    vanished would also stop firing, and that is the outcome the issue explicitly refused.
		await page.goto('/rules');
		const pausedRow = page.locator('table tbody tr').filter({ hasText: RULE });
		await expect(pausedRow).toHaveCount(1);
		await expect(pausedRow).toContainText(m.rules_status_paused());
		await expect(pausedRow).toContainText(m.rules_paused_reason());
		// The way out, per the design note that a paused rule must not leave the user guessing that
		// editing is the answer.
		await expect(pausedRow).toContainText(m.rules_paused_hint());
		await expect(pausedRow).not.toContainText(m.rules_status_active());
	});
});
