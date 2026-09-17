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
 * THE OTHER HALF OF THE MEMORISATION SPLIT, and it exists because a deletion is invisible.
 *
 * The designation screen used to carry « Cette correspondance sera réutilisée pour les prochains
 * fichiers ayant les mêmes colonnes » directly above its opt-out link, as one 86 px block. State 2
 * had 5 px of air, the Date row's reading line costs 18, and the screen scrolled, which the plate
 * forbids. The SENTENCE moved here and the LINK stayed there: a disclosure is not owed before the
 * act, and a consent is.
 *
 * `ColumnDesignationScreen.states.svelte.spec.ts` asserts the sentence is no longer on that screen.
 * On its own that assertion is satisfied by deleting the sentence and never rendering it anywhere,
 * which is exactly the outcome the split must not produce. This file asserts it ARRIVED.
 *
 * ## Why every assertion names a chrome and a width
 *
 * This page renders its whole content TWICE, `hidden lg:block` and `lg:hidden`, so every locator
 * resolves to two elements and exactly one is visible. `cap-reached.svelte.spec.ts` records what
 * that costs: a line added to one chrome and not the other is invisible to any test that does not
 * choose. The same discipline is applied here, and for the same reason it was needed there, this
 * line is drawn twice in `+page.svelte`.
 *
 * DOM order is the discriminator: the desktop section is declared first, the mobile second.
 */
const BASE: ImportSummaryResult = {
	fileName: 'releve.csv',
	profile: 'mapped',
	totalRows: 12,
	importedRows: 12,
	invalidRows: 0,
	fileLevelRefusals: 0,
	duplicateRows: 0,
	autoCategorizedRows: 0,
	totalDebitCents: 4200,
	totalCreditCents: 0,
	period: { from: '2026-07-01', to: '2026-07-31' },
	batchId: 'batch-1',
	invalidRowDetails: [],
	hiddenInvalidRowsCount: 0,
	accountName: null,
	multiAccountFile: false,
	rememberedMapping: true
};

const DATA: PageData = { user: null, correction: null };

const sentences = () => page.getByText(m.import_columns_remember_sentence());

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

describe('what the import memorised is disclosed on the summary', () => {
	/**
	 * Separates « the sentence reached the desktop chrome » from « it reached the mobile one and the
	 * desktop copy was forgotten ». Both are consistent with the string appearing somewhere on the
	 * page, which is what a single unqualified locator would assert.
	 */
	it('states at 1280 that the correspondance will be reused', async () => {
		await page.viewport(1280, 800);
		show(BASE);

		await expect.element(sentences().first()).toBeVisible();
	});

	/**
	 * The mobile chrome, at the width it is drawn for. Same claim, other copy.
	 */
	it('states at 390 that the correspondance will be reused', async () => {
		await page.viewport(390, 844);
		show(BASE);

		await expect.element(sentences().last()).toBeVisible();
	});

	/**
	 * THE PLANTED NEGATIVE, and it is the assertion that carries the bar.
	 *
	 * Separates « the sentence is drawn from what the import did » from « the sentence is drawn
	 * unconditionally ». A user who pressed « Ne pas mémoriser » and is then told their columns will
	 * be reused has been shown a false statement on the one screen whose job is reporting what
	 * happened, and the two states are otherwise identical on this surface.
	 *
	 * Absence is asserted at BOTH widths in one test because the element count is a page-wide figure
	 * here: the two tests above establish that the count is 2 when it should be, so 0 is a state and
	 * not a locator that never matches.
	 */
	it('says nothing when the user declined to memorise', async () => {
		await page.viewport(390, 844);
		show({ ...BASE, rememberedMapping: false });

		expect(sentences().elements().length).toBe(0);
	});
});
