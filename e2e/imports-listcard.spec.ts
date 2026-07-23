import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

// Wave 3 of the component repository migration: /imports' mobile batch-history list now
// wraps each batch in the shared ListCard. "Voir" (view transactions) stays always visible
// — it's the most useful action on this page; only cancel/delete (destructive: removes the
// imported transactions) moves behind ListCard's tap-to-expand details slot, using
// expandAriaLabel so each row's toggle has a unique accessible name per file, since a user
// can have several import batches. The upload page (/import) is out of scope for this
// migration — it's a form + result summary, not a list of items.
//
// No import batch is seeded by default (the shared e2e dataset's 2 transactions are created
// via manual form actions, not a CSV import — see e2e/seed.ts), so this spec creates its own
// via a real CSV upload through /import, mirroring e2e/csv-import.spec.ts's pattern. Scoped
// to this batch's own filename so it's robust to other batches already existing from other
// specs sharing the same DB.
test('imports mobile ListCard: view is visible without expanding; cancel is behind the expand toggle', async ({
	page
}) => {
	const fileName = 'e2e-listcard-import.csv';
	const csv = [
		'date,libelle,categorie,montant,type,nature,source_bancaire',
		'2026-04-10,E2E ListCard import row,E2E ListCard category,"-12,00",expense,,'
	].join('\n');

	await page.goto('/import');
	const form = page.locator('form[method="POST"]').first();
	await form
		.locator('input[name="csvFile"]')
		.setInputFiles({ name: fileName, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf-8') });
	await form.getByRole('button', { name: m.import_submit() }).click();

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/imports');

	const card = page.locator('div.lg\\:hidden div.space-y-3 > div', { hasText: fileName }).first();
	await expect(card).toBeVisible();

	await expect(card.getByRole('link', { name: m.imports_view() })).toBeVisible();
	await expect(card.getByRole('button', { name: m.common_delete(), exact: true })).toHaveCount(0);

	const expandToggle = card.getByRole('button', {
		name: m.imports_cancel_expand_aria({ name: fileName })
	});
	await expect(expandToggle).toBeVisible();
	await expandToggle.click();

	const deleteButton = card.getByRole('button', { name: m.common_delete(), exact: true });
	await expect(deleteButton).toBeVisible();
	await deleteButton.click();

	const dialog = page.getByRole('dialog', { name: m.imports_cancel_confirm_title() });
	await expect(dialog).toBeVisible();
	// The confirm copy must state how many transactions will actually be deleted (1 in this
	// case), not a generic "transactions will be deleted" — cancelling an import can remove
	// many rows at once, so the count is the real safety signal here.
	await expect(
		dialog.getByText(m.imports_cancel_confirm_description_count_one({ count: 1 })).first()
	).toBeVisible();
});
