import { describe, it, expect, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../layout.css';
import * as m from '$lib/paraglide/messages';
import { setCompletedImport, takeCompletedImport } from '$lib/import/completedImport.svelte';
import type { ImportSummaryResult } from '$lib/domain/importSummary';
import Page from './+page.svelte';
import type { PageData } from './$types';

/**
 * PLATE 7L'S DISCLOSURE, on the summary panel this page draws once per chrome.
 *
 * « Dates lues jour puis mois — Date operation » states a proof and appears only where the reading
 * was CHOSEN rather than proven or defaulted: `CsvImportSummary.dateOrderDisclosure`'s docstring
 * carries the one rule, and this file asserts its arrival on the screen a user actually meets.
 *
 * ## Why every assertion names a chrome and a width
 *
 * This page renders its whole content TWICE, `hidden lg:block` and `lg:hidden`, so every locator
 * resolves to two elements and exactly one is visible. `cap-reached.svelte.spec.ts` and
 * `remember-disclosure.svelte.spec.ts` record what that costs: a line added to one chrome and not
 * the other is invisible to any test that does not choose. DOM order is the discriminator: the
 * desktop section is declared first, the mobile section second.
 */
const BASE: ImportSummaryResult = {
	fileName: 'releve.csv',
	profile: 'generic',
	totalRows: 3,
	importedRows: 3,
	invalidRows: 0,
	fileLevelRefusals: 0,
	duplicateRows: 0,
	autoCategorizedRows: 0,
	totalDebitCents: 4200,
	totalCreditCents: 0,
	period: { from: '2026-04-01', to: '2026-04-30' },
	batchId: 'batch-1',
	invalidRowDetails: [],
	hiddenInvalidRowsCount: 0,
	accountName: null,
	rememberedMapping: false,
	dateOrderDisclosure: { header: 'Date operation', order: 'month-first' }
};

const DATA: PageData = { user: null, correction: null };

const lines = () =>
	page.getByText(m.import_summary_date_reading_month_first({ header: 'Date operation' }));

beforeEach(() => {
	// Read-once by design, so a value left by a previous test would make an absence assertion pass
	// or fail for the wrong reason.
	takeCompletedImport();
});

function show(importResult: ImportSummaryResult) {
	setCompletedImport({
		importResult,
		capReached: false,
		canRevisit: false,
		replaced: { kind: 'none' }
	});
	render(Page, { data: DATA, form: null });
}

describe('the chosen date reading is disclosed on the summary', () => {
	/**
	 * Separates « the disclosure reached the desktop chrome » from « it reached the mobile one and
	 * the desktop copy was forgotten ». Both are consistent with the string appearing somewhere on
	 * the page, which is what a single unqualified locator would assert.
	 */
	it('states at 1280 which column and reading were chosen', async () => {
		await page.viewport(1280, 800);
		show(BASE);

		await expect.element(lines().first()).toBeVisible();
	});

	/** The mobile chrome, at the width it is drawn for. Same claim, other copy. */
	it('states at 390 which column and reading were chosen', async () => {
		await page.viewport(390, 844);
		show(BASE);

		await expect.element(lines().last()).toBeVisible();
	});

	/** The sibling reading, so the test cannot pass on a hard-coded string. */
	it('states the day-first reading when that is what was chosen', async () => {
		await page.viewport(1280, 800);
		show({ ...BASE, dateOrderDisclosure: { header: 'Date operation', order: 'day-first' } });

		await expect
			.element(
				page
					.getByText(m.import_summary_date_reading_day_first({ header: 'Date operation' }))
					.first()
			)
			.toBeVisible();
	});

	/**
	 * THE PLANTED NEGATIVE, and it is the assertion that carries the bar.
	 *
	 * Separates « the line is drawn from what the parse decided » from « the line is drawn
	 * unconditionally ». A proven or defaulted import stating a "chosen" reading would be a false
	 * displayed figure: it claims a decision nobody took.
	 *
	 * Absence is asserted at both widths in one test because the element count is a page-wide
	 * figure here: the tests above establish that the count is 2 when it should be, so 0 is a state
	 * and not a locator that never matches.
	 */
	it('discloses nothing when the reading was not chosen', async () => {
		await page.viewport(390, 844);
		show({ ...BASE, dateOrderDisclosure: null });

		expect(lines().elements().length).toBe(0);
	});
});
