import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Page from './+page.svelte';
import * as m from '$lib/paraglide/messages';

/**
 * The one thing this panel never said about the user's money.
 *
 * ## The defect this reproduces
 *
 * A blind walk designated the columns of an unrecognised statement by hand and chose, for the
 * category slot, the option spelled « Aucune — les transactions arriveront non catégorisées ».
 * Eight rows imported. Two of them arrived carrying a category, indistinguishable in the list from
 * one the user had set, with nothing anywhere saying it had happened.
 *
 * They are not a defect of the parser: `persistImportedTransactions` runs the user's own rules over
 * what it has just written, which is the behaviour the rules screen promises and is wanted. What
 * was missing is the sentence. « Aucune » is a true statement about the COLUMN — nothing was read
 * out of the file — and the user reads it as a statement about the transactions, because that is
 * what the option's own words say.
 *
 * ## Why a count and not a flag
 *
 * The panel already answers « what became of my rows » in figures. « Some were categorised » is
 * the shape of sentence a reader cannot act on: two of eight is a note, and eight of eight is the
 * reason their budget looks nothing like they expected. The number is what makes the difference
 * checkable against the list.
 *
 * Both breakpoint copies of the page render simultaneously, so a figure of 2 below is one per copy.
 */

const DATA = {
	linkableNetWorthAccounts: [],
	rememberedMappings: [],
	batches: []
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function formWith(overrides: Record<string, unknown> = {}) {
	return {
		importResult: {
			fileName: 'releve.csv',
			profile: 'generic',
			totalRows: 8,
			importedRows: 8,
			invalidRows: 0,
			fileLevelRefusals: 0,
			duplicateRows: 0,
			autoCategorizedRows: 2,
			totalDebitCents: 4200,
			totalCreditCents: 0,
			period: null,
			batchId: 'batch-1',
			invalidRowDetails: [],
			hiddenInvalidRowsCount: 0,
			netWorthLinkStatus: null,
			...overrides
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

describe('the import summary says when it categorised transactions by itself', () => {
	it('states the count, in both breakpoint copies', async () => {
		expect.assertions(1);
		await page.viewport(1280, 800);
		render(Page, { data: DATA, form: formWith() });

		// Built from the fixture's own figure through the catalogue: a hardcoded string here would
		// assert this test's spelling and would keep passing on a page interpolating the wrong count.
		expect(
			page.getByText(m.import_summary_auto_categorized_many({ count: 2 })).elements()
		).toHaveLength(2);
	});

	it('agrees with itself on one, where the plural would be wrong', async () => {
		expect.assertions(1);
		await page.viewport(1280, 800);
		render(Page, { data: DATA, form: formWith({ autoCategorizedRows: 1 }) });

		expect(
			page.getByText(m.import_summary_auto_categorized_one({ count: 1 })).elements()
		).toHaveLength(2);
	});

	it('says nothing at all when no rule fired', async () => {
		expect.assertions(1);
		await page.viewport(1280, 800);
		// The calibration. A sentence that always renders is not a disclosure, it is furniture, and
		// the reader stops seeing it on the imports where it matters.
		render(Page, { data: DATA, form: formWith({ autoCategorizedRows: 0 }) });

		expect(page.getByText(m.import_summary_auto_categorized_many({ count: 0 })).elements()).toEqual(
			[]
		);
	});
});
