import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

// /imports' mobile batch-history list wraps each batch in the shared ListCard. Both actions are
// now always visible: "Voir" and the destructive control, side by side in the card's action row.
//
// THE DISCLOSURE IS GONE (Planche 5e), and with it the gap this comment used to file. It read that
// each row's toggle was named after its file so the rows could be told apart, which stopped being
// true the moment a correction made a re-import of one statement under one file name the ordinary
// case: two cards, one label. Two presses for a rare action protected nothing either, they hid it,
// and the disclosure's own name said « Supprimer <file> » while deleting nothing.
//
// The control is now named by the TIMESTAMP, which is the attribute two candidates do not share,
// so this spec reaches it by name rather than by position. That closes #380.
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
	// No disclosure left on the card: an absolute zero beside the positive assertions below, which
	// are what prove the queries reach anything at all.
	await expect(card.locator('button[aria-expanded]')).toHaveCount(0);

	// Read before the dialog opens, because it is what the dialog's own name has to agree with. The
	// card heads itself with this import's timestamp, and after a correction that timestamp is the
	// only thing telling two otherwise identical rows apart, so the confirmation is titled with it.
	const shownDate = ((await card.locator('p[title]').first().textContent()) ?? '').trim();
	expect(shownDate).not.toBe('');

	// Named by the timestamp the card already shows, so the row is reachable without counting.
	const deleteButton = card.getByRole('button', {
		name: m.imports_delete_aria({ date: shownDate })
	});
	await expect(deleteButton).toBeVisible();
	await deleteButton.click();

	const dialog = page.getByRole('dialog', {
		name: m.imports_delete_confirm_title({ date: shownDate })
	});
	await expect(dialog).toBeVisible();
	// The confirm copy must state how many transactions will actually be deleted (1 in this
	// case), not a generic "transactions will be deleted" — cancelling an import can remove
	// many rows at once, so the count is the real safety signal here.
	await expect(
		dialog.getByText(m.imports_delete_confirm_description_count_one({ count: 1 })).first()
	).toBeVisible();
});
