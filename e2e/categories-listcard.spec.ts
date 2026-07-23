import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

// Builds a "starts with the localized prefix" regex from a Paraglide message template that
// takes a single interpolated {name}, by rendering it with an empty name and escaping the
// resulting literal prefix — avoids hardcoding the French prefix while still tolerating any
// per-row suffix (category name) without needing to know it up front.
function prefixOf(rendered: string): RegExp {
	return new RegExp('^' + rendered.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

// Wave 3 of the component repository migration: /categories' mobile list now wraps each
// category card in the shared ListCard. The nature Select stays always visible (functional
// control used per-category, not an action) and rename moves into the primary row's header;
// only delete (destructive) moves behind ListCard's tap-to-expand details slot, mirroring
// /rules. The system category ("Non catégorisé") has no rename/delete at all and gets no
// expand toggle — not covered here since the seeded e2e user has no uncategorized
// transaction, so that row is never lazily created for this dataset.
test.describe('categories mobile ListCard', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('nature select and rename are visible without expanding; delete is behind the expand toggle', async ({
		page
	}) => {
		await page.goto('/categories');

		const mobileList = page.locator('section.lg\\:hidden div.space-y-3');
		const firstCard = mobileList.locator('> div').first();

		await expect(
			firstCard.getByRole('button', { name: prefixOf(m.categories_nature_aria({ name: '' })) })
		).toBeVisible();
		await expect(
			firstCard.getByRole('button', {
				name: prefixOf(m.categories_rename_aria({ name: '' })),
				exact: false
			})
		).toBeVisible();
		await expect(
			firstCard.getByRole('button', { name: m.common_delete(), exact: true })
		).toHaveCount(0);

		const expandToggle = firstCard.getByRole('button', {
			name: prefixOf(m.categories_delete_expand_aria({ name: '' }))
		});
		await expect(expandToggle).toBeVisible();
		await expandToggle.click();

		const deleteButton = firstCard.getByRole('button', { name: m.common_delete(), exact: true });
		await expect(deleteButton).toBeVisible();
		await deleteButton.click();

		await expect(page.getByRole('dialog')).toBeVisible();
	});

	test('each row expand toggle has a distinct, per-category accessible name', async ({ page }) => {
		await page.goto('/categories');

		const mobileList = page.locator('section.lg\\:hidden div.space-y-3');
		const cards = mobileList.locator('> div');

		const deletePrefix = prefixOf(m.categories_delete_expand_aria({ name: '' }));
		const firstToggle = cards.nth(0).getByRole('button', { name: deletePrefix });
		const secondToggle = cards.nth(1).getByRole('button', { name: deletePrefix });

		const firstName = await firstToggle.getAttribute('aria-label');
		const secondName = await secondToggle.getAttribute('aria-label');

		expect(firstName).toBeTruthy();
		expect(secondName).toBeTruthy();
		expect(firstName).not.toBe(secondName);
	});
});
