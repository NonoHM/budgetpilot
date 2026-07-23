import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

// Builds a "starts with the localized prefix" regex from a Paraglide message template that
// takes a single interpolated {name}, by rendering it with an empty name and escaping the
// resulting literal prefix.
function prefixOf(rendered: string): RegExp {
	return new RegExp('^' + rendered.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

// Wave 3 of the component repository migration: /rules' mobile list now wraps each rule
// card in the shared ListCard. The enable/disable toggle and edit action stay always
// visible (toggle is a functional control used per-rule, edit is the primary action);
// only delete (destructive) moves behind ListCard's tap-to-expand details slot, mirroring
// /budgets and /net-worth. Unlike those two (single seeded row each), /rules always has
// several default rules, so the expand toggle keeps ListCard's neutral "···" visible glyph
// (via expandAriaLabel, not expandLabel) while giving each row's toggle a unique, honest
// accessible name ("Supprimer la règle {name}") — avoids both a repeated ambiguous label
// and an over/under-promising generic "show details" label. The delete button revealed
// inside the expanded details keeps the generic "Supprimer" label — unambiguous in
// practice since it's only reachable right after activating that specific row's toggle.
test.describe('rules mobile ListCard', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('toggle and edit are visible without expanding; delete is behind the expand toggle', async ({
		page
	}) => {
		await page.goto('/rules');

		// Scoped to the mobile-only container (desktop renders the same rows in a <table>,
		// hidden via CSS but still present in the DOM at this viewport).
		const mobileList = page.locator('div.lg\\:hidden.space-y-4');
		const firstCard = mobileList.locator('div.space-y-3 > div').first();

		await expect(firstCard.getByRole('switch')).toBeVisible();
		await expect(firstCard.getByRole('button', { name: m.rules_edit() })).toBeVisible();

		const expandToggle = firstCard.getByRole('button', {
			name: prefixOf(m.rules_delete_expand_aria({ name: '' }))
		});
		await expect(expandToggle).toBeVisible();
		await expect(expandToggle).toHaveText('···');
		await expect(expandToggle).toHaveAttribute('aria-expanded', 'false');

		await expect(
			firstCard.getByRole('button', { name: m.common_delete(), exact: true })
		).toHaveCount(0);

		await expandToggle.click();
		await expect(expandToggle).toHaveAttribute('aria-expanded', 'true');

		const deleteButton = firstCard.getByRole('button', { name: m.common_delete(), exact: true });
		await expect(deleteButton).toBeVisible();
		await deleteButton.click();

		await expect(page.getByRole('dialog', { name: m.rules_delete_confirm_title() })).toBeVisible();
	});
});
