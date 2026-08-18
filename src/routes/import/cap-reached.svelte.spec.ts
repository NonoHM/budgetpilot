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
 * The memorisation refusal, which was computed, carried, typed and rendered by NOTHING.
 *
 * `saveColumnMapping` refuses with `cap-reached` once a user holds `COLUMN_MAPPINGS_PER_USER`
 * correspondances. `/import/columns` returns that as `capReached`, the client stores it on
 * `CompletedImport`, and `/import` drew no part of it. Meanwhile the designation screen had already
 * displayed « Cette correspondance sera réutilisée pour les prochains fichiers ayant les mêmes
 * colonnes ». So the application made a promise, declined to keep it, and said nothing: the only
 * symptom was that the same bank kept reopening the designation screen forever.
 *
 * ## Why every assertion names a chrome and a width
 *
 * This page renders its whole content TWICE, `hidden lg:block` and `lg:hidden`, so every locator
 * here resolves to two elements and exactly one of them is visible. Selecting `.first()` without
 * pinning the width picks the DESKTOP copy, which at 390 is display:none, and the failure reads as
 * "the notice is missing" when the notice is present and hidden. The two chromes are therefore
 * driven separately, at the widths they are drawn for, which is also the only way to see that the
 * fix reached both: a notice added to one chrome and not the other is invisible to any test that
 * does not choose.
 *
 * DOM order is the discriminator: the desktop section is declared first, the mobile section second.
 */

const SUMMARY: ImportSummaryResult = {
	fileName: 'releve.csv',
	profile: 'mapped',
	totalRows: 12,
	importedRows: 12,
	invalidRows: 0,
	fileLevelRefusals: 0,
	duplicateRows: 0,
	totalDebitCents: 4200,
	totalCreditCents: 0,
	period: { from: '2026-07-01', to: '2026-07-31' },
	batchId: 'batch-1',
	invalidRowDetails: [],
	hiddenInvalidRowsCount: 0,
	netWorthLinkStatus: null
};

const DATA: PageData = {
	// Inherited from the layout load. Null is honest here: this component reads none of it, and a
	// fabricated user would be a fixture detail that looks like a precondition of the assertion.
	user: null,
	correction: null,
	linkableNetWorthAccounts: [],
	hasAllImportBucketsExisting: true
};

/**
 * The notice as each chrome draws it. Desktop is declared first in the document.
 *
 * Located by the BANNER, then filtered on its sentence, rather than by the sentence alone.
 * `getByText` returns the innermost element whose text matches, and the banner stopped being a
 * single text node the day it gained its « Supprimez-en une dans Paramètres » action (#326): the
 * sentence and the link are now two children of one alert. Matching on the text alone therefore
 * resolved to whichever node the retry loop happened to observe mid-render, which passed locally
 * six runs out of six and failed twice under CI's load. The alert is one element, present from
 * the first paint, and it is what the user sees as « the notice ».
 */
const notices = () => page.getByRole('alert').filter({ hasText: m.import_columns_cap_reached() });
const desktopNotice = () => notices().first();
const mobileNotice = () => notices().last();

beforeEach(() => {
	// The module is read-once by design, so a value left by a previous test would leak into the
	// next one and make an assertion about absence pass or fail for the wrong reason.
	takeCompletedImport();
});

describe('the memorisation cap is reported on the import it happened to', () => {
	it('states at 1280 that the columns were not remembered', async () => {
		await page.viewport(1280, 800);
		setCompletedImport({
			importResult: SUMMARY,
			capReached: true,
			canRevisit: false,
			replaced: { kind: 'none' }
		});

		render(Page, { data: DATA, form: null });

		await expect.element(desktopNotice()).toBeVisible();
	});

	it('states at 390 that the columns were not remembered', async () => {
		await page.viewport(390, 844);
		setCompletedImport({
			importResult: SUMMARY,
			capReached: true,
			canRevisit: false,
			replaced: { kind: 'none' }
		});

		render(Page, { data: DATA, form: null });

		await expect.element(mobileNotice()).toBeVisible();
	});

	/**
	 * THE DIRECTION THIS CHANGE IS NOT MOVING IN, and the one that would go unnoticed.
	 *
	 * The fix makes the page say MORE, so the loss lives on the other side: a notice that appeared
	 * on every import would be worse than the silence it replaces, because it would tell a user
	 * whose correspondance WAS memorised that it was not. Asserted on the same summary, so the only
	 * thing separating this case from the two above is the flag itself.
	 *
	 * The visible summary is waited on FIRST. An absence assertion read before the page has settled
	 * measures the framework's batching and would pass against a page that has rendered nothing at
	 * all, which is the failure mode this repository records as a detector that cannot detect.
	 */
	it('says nothing at all when the correspondance was memorised', async () => {
		await page.viewport(390, 844);
		setCompletedImport({
			importResult: SUMMARY,
			capReached: false,
			canRevisit: false,
			replaced: { kind: 'none' }
		});

		render(Page, { data: DATA, form: null });

		await expect.element(page.getByText(m.import_summary_heading()).last()).toBeVisible();
		await expect.element(mobileNotice()).not.toBeInTheDocument();
	});

	/**
	 * The notice QUALIFIES the summary rather than replacing it. Written because the obvious wrong
	 * fix is an early return that swaps the counts for the warning, which would hide the fact that
	 * the import itself succeeded -- the single most important thing the sentence claims.
	 */
	it('leaves the summary counts standing beside the notice', async () => {
		await page.viewport(390, 844);
		setCompletedImport({
			importResult: SUMMARY,
			capReached: true,
			canRevisit: false,
			replaced: { kind: 'none' }
		});

		render(Page, { data: DATA, form: null });

		await expect.element(mobileNotice()).toBeVisible();
		await expect.element(page.getByText(m.import_summary_heading()).last()).toBeVisible();
		await expect.element(page.getByText(SUMMARY.fileName).last()).toBeVisible();
	});
});
