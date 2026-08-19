import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Page from './+page.svelte';
import { importProfileLabel } from '$lib/domain/importProfileLabel';

/**
 * The badge on the import summary, which was printing a database value.
 *
 * ## The defect this reproduces
 *
 * A blind walk designated the columns of an unrecognised statement, imported it, and read a badge
 * on the summary saying « mapped » — one English word, in lower case, on an otherwise entirely
 * French screen, naming a parser. The same import listed on /imports two clicks away says « Sur
 * mesure ».
 *
 * So the label existed and this panel was not using it. `importProfileLabel` was written for
 * exactly this defect on /imports (see its own doc), and the summary was never moved onto it.
 *
 * ## Asserted through the function rather than against a string
 *
 * The expectation calls `importProfileLabel`, which is the production rendering. Typing « Sur
 * mesure » here would pin this test's spelling of a caption instead of the page's agreement with
 * the rest of the product, and would go red on a rename that changed both correctly.
 *
 * `maison` is the second case on purpose: it is the token an AUTO-recognised import carries, so a
 * fix applied only to the designated path leaves the ordinary import still printing a token.
 */

const DATA = {
	linkableNetWorthAccounts: [],
	rememberedMappings: [],
	batches: []
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function formWithProfile(profile: string) {
	return {
		importResult: {
			fileName: 'releve.csv',
			profile,
			totalRows: 8,
			importedRows: 8,
			invalidRows: 0,
			fileLevelRefusals: 0,
			duplicateRows: 0,
			autoCategorizedRows: 0,
			totalDebitCents: 4200,
			totalCreditCents: 0,
			period: null,
			batchId: 'batch-1',
			invalidRowDetails: [],
			hiddenInvalidRowsCount: 0,
			netWorthLinkStatus: null
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

describe('the import summary names the format the way the rest of the product names it', () => {
	it.each(['mapped', 'maison', 'banque-populaire'])(
		'renders %s through the shared label, in both breakpoint copies',
		async (profile) => {
			expect.assertions(2);
			await page.viewport(1280, 800);
			render(Page, { data: DATA, form: formWithProfile(profile) });

			expect(page.getByText(importProfileLabel(profile), { exact: true }).elements()).toHaveLength(
				2
			);
			// The half that catches a page rendering both: the raw token must be gone, not merely
			// accompanied.
			expect(page.getByText(profile, { exact: true }).elements()).toEqual([]);
		}
	);
});
