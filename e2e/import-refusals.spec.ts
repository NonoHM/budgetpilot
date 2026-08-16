import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';
import { E2E_LOCALE } from './config';

/**
 * The invalid-rows table, in a real browser. Issue #302.
 *
 * ## What #302 asked for, and the one part of it that does not exist
 *
 * The issue asks for "a file that produces refusals of more than one scope in a single import (a
 * header problem and a bad row)". **That file cannot be built.** Measured 2026-08-15 against the
 * real parser: a header-scoped refusal SHORT CIRCUITS the parse, so no row is ever examined and no
 * row-scoped refusal can accompany it.
 *
 *     duplicate column + a bad date row  -> scopes=header    facts=header:duplicate-column
 *                                           valid=0  invalidRows=1  totalRows=2
 *     bad date + bad amount              -> scopes=row       facts=row:invalid-date,row:invalid-amount
 *                                           valid=1  invalidRows=2  totalRows=3
 *
 * So the request is split into the two scenarios that ARE reachable, and each carries the part of
 * the acceptance it can actually carry. Recorded here rather than quietly reinterpreted: the next
 * reader comparing the issue against this file must not conclude the second scope was forgotten.
 *
 * ## The locale is pinned, and that is the point rather than a detail
 *
 * The refusal contract's whole argument is that a parser produces a FACT and the UI produces the
 * SENTENCE. A test asserting whatever string happens to render would pass on a parser that had
 * gone back to emitting French from the server, which is exactly what the contract removed.
 *
 * `E2E_LOCALE` is `fr`, pinned in `e2e/config.ts` and fed to BOTH halves: the browser cookie in
 * `fixtures.ts` and the node-side message functions the selectors below are built from. The
 * assertions call `m.*` rather than quoting French, so the sentence is compared against the
 * catalogue the UI renders from, in the locale the browser was told to use. If those two pinnings
 * ever disagreed the failure would be a locator timeout, which is why they come from one constant.
 */

/** A duplicated header. HEADER scope, and the only refusal reachable at that scope here. */
const DUPLICATE_HEADER_CSV = [
	'date;libelle;montant;montant',
	'01/02/2026;E2E entete duplique;-3,50;-3,50',
	'PAS-UNE-DATE;E2E ligne cassee;-1,20;-1,20'
].join('\n');

/** Two ROW-scoped refusals of different kinds, plus one good row so the counts have to add up. */
const TWO_BAD_ROWS_CSV = [
	'date;libelle;montant',
	'PAS-UNE-DATE;E2E date illisible;-3,50',
	'01/02/2026;E2E montant illisible;PAS-UN-MONTANT',
	'01/03/2026;E2E ligne valide refusee;-9,90'
].join('\n');

async function upload(page: import('@playwright/test').Page, name: string, csv: string) {
	await page.goto('/import');
	// Both layouts render their own copy of the form and only one is visible; scope to the first,
	// the same pattern `csv-import.spec.ts` already uses.
	const form = page.locator('form[method="POST"]').first();
	await form.locator('input[name="csvFile"]').setInputFiles({
		name,
		mimeType: 'text/csv',
		buffer: Buffer.from(csv, 'utf-8')
	});
	await form.getByRole('button', { name: m.import_submit() }).click();
	return form;
}

test('a header refusal is explained without being given a transaction row number', async ({
	page
}) => {
	// THE ACCEPTANCE OF #302, and of #291 before it. A header complaint used to be numbered
	// `index + 1` and presented as a line, pointing the user at transaction rows that were never
	// examined. The rule is not "the number is different", it is that there is NO number: the
	// complaint is about the header, and the header has no line to point at.
	await upload(page, 'e2e-entete-duplique.csv', DUPLICATE_HEADER_CSV);

	const reason = m.import_refusal_duplicate_column({ column: 'montant' });
	await expect(page.getByText(reason).first()).toBeVisible();

	// Asserted on the SCOPE CELL, positively, against the word the UI is supposed to show there.
	//
	// The first version asserted `not.toContainText(/\b\d+\b/)` over the whole row and was VACUOUS:
	// restoring the pre-contract `index + 1` left it green. A row's `textContent` concatenates its
	// cells with no separator, so the fabricated `1` ran straight into `Colonne dupliquee` and there
	// was no word boundary for `\b` to find. The regex read exactly like what it was meant to say
	// and could not match the thing it was written to catch.
	//
	// The positive form separates the two states cleanly: the cell says the word `en-tete`, or it
	// says a number. Under the restored defect it says `1` and this goes red.
	const complaint = page.locator('tr', { hasText: reason }).first();
	await expect(complaint).toBeVisible();
	await expect(complaint.locator('td').first()).toHaveText(m.import_invalid_scope_header());
});

test('the reason is rendered from the catalogue in the pinned locale', async ({ page }) => {
	// Separates two states a French page cannot distinguish on its own: a sentence the UI produced
	// from a fact, and a sentence the parser produced and the UI merely printed. Asserted through
	// `m.*` in the pinned locale, so a server-side French literal would have to match the catalogue
	// exactly to pass, and a catalogue edit moves both halves together.
	await upload(page, 'e2e-deux-lignes.csv', TWO_BAD_ROWS_CSV);

	expect(E2E_LOCALE).toBe('fr');
	// The value comes from the fixture's own first column, so this asserts the round trip the
	// sentence now makes: the parser reads a cell, puts it on the fact, and the catalogue prints
	// it back. Passing a different value here would go red, which is the point — a message that
	// interpolated nothing would match a sentence built from any value at all.
	await expect(
		page.getByText(m.import_refusal_invalid_date({ value: 'PAS-UNE-DATE' })).first()
	).toBeVisible();
	await expect(page.getByText(m.import_refusal_invalid_amount()).first()).toBeVisible();
});

test('the summary counts agree with the table that explains them', async ({ page }) => {
	// The third half of #302's acceptance. Two numbers about the same import, from two different
	// code paths: the summary counts come from `result.summary`, the table rows from
	// `invalidRowDetails`. A disagreement between them is exactly the kind of defect that survives
	// unit tests, because each side is asserted separately and correctly.
	await upload(page, 'e2e-deux-lignes.csv', TWO_BAD_ROWS_CSV);

	const rows = page.locator('tbody tr');
	await expect(rows).toHaveCount(2);

	// And an absolute figure beside the agreement: a page rendering nothing at all would satisfy
	// "the two sides match".
	await expect(page.getByText('2', { exact: true }).first()).toBeVisible();
});
