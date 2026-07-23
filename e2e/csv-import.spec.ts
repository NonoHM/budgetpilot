import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

// Real end-to-end coverage of the import money parser (parseAmountCents, server/import/utils/
// money.ts — now delegating to the shared domain/money.ts core, see money parsers
// consolidation): uploads a small "maison" CSV through the real /import form and asserts the
// comma-decimal amount lands as the correct cents value in the resulting transaction, rather
// than only unit-testing the parser in isolation.
test('importing a maison CSV parses a comma-decimal amount correctly', async ({ page }) => {
	// A non-empty category is deliberate: leaving it blank would land the imported transaction
	// in the "Non catégorisé" pile and break the unrelated empty-states e2e spec, which asserts
	// that pile is empty once the seed data has been triaged (e2e specs share one DB).
	const csv = [
		'date,libelle,categorie,montant,type,nature,source_bancaire',
		'2026-03-15,E2E CSV import comma amount,E2E CSV category,"42,50",income,,'
	].join('\n');

	await page.goto('/import');

	// Both the desktop and mobile layouts render their own copy of the form (only one is
	// visible via CSS at a time) — scope to the visible (desktop, ≥lg viewport) one, same
	// pattern as money-input.spec.ts's dialog-scoped locators.
	const form = page.locator('form[method="POST"]').first();
	await form.locator('input[name="csvFile"]').setInputFiles({
		name: 'e2e-maison.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(csv, 'utf-8')
	});

	await form.getByRole('button', { name: m.import_submit() }).click();

	await page.goto('/transactions');
	await expect(page.getByText('E2E CSV import comma amount').first()).toBeVisible();
	await expect(page.getByText('42,50').first()).toBeVisible();
});
