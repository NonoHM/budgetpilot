import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Page from './+page.svelte';

/**
 * What COLOUR the summary figures are, which is a claim about the figures and not decoration.
 *
 * ## The defect this reproduces
 *
 * Read off a screenshot of a clean import: 8 imported, 0 duplicates, 0 invalid — and « LIGNES
 * INVALIDES 0 » drawn in rose. A zero there is the best news the panel has; it was painted in the
 * colour the same panel uses for a refusal, twelve pixels from a red banner.
 *
 * The desktop chrome hardcoded `text-rose-700` on that tile. The mobile chrome, in the same
 * component, forty lines apart, gated the identical class on `invalidRows > 0` — and gated an
 * amber on duplicates that the desktop chrome does not have at all.
 *
 * ## Asserted as agreement between the chromes, not against a palette
 *
 * The two copies render simultaneously and are the same panel at two widths. Naming the expected
 * class per tile would pin a palette this test has no authority over, and would go red on a
 * redesign that kept both chromes correct and consistent. Comparing them to each other states the
 * property that was actually broken: one of them is wrong and nothing could see it, because every
 * spec on this panel reads text and no spec had ever put the two side by side.
 *
 * That is the seam this file exists for. `summary-figures.svelte.spec.ts` counts tiles in both
 * chromes and passes on a page where one of them is the wrong colour.
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
			autoCategorizedRows: 0,
			totalDebitCents: 36735,
			totalCreditCents: 252430,
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

/** The semantic colour carried by each tile's VALUE, one array per chrome, in tile order. */
function tonesPerChrome(): string[][] {
	const grids = Array.from(document.querySelectorAll('[data-testid="import-summary-figures"]'));
	return grids.map((grid) =>
		Array.from(grid.children).map((tile) => {
			const value = tile.querySelector('p:last-of-type');
			const classes = Array.from(value?.classList ?? []);
			return classes.find((name) => /^text-(rose|emerald|amber)-\d{3}$/.test(name)) ?? 'none';
		})
	);
}

describe('the two chromes of the summary agree on what each figure means', () => {
	it.each([
		['a clean import', {}],
		['rows refused', { invalidRows: 3, importedRows: 5 }],
		['duplicates skipped', { duplicateRows: 8, importedRows: 0 }]
	])('%s is coloured the same way at both widths', async (_name, overrides) => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		render(Page, { data: DATA, form: formWith(overrides) });

		const [desktop, mobile] = tonesPerChrome();
		expect(desktop).toHaveLength(5); // calibration: the grids are there to be compared
		expect(desktop).toStrictEqual(mobile);
	});

	it('does not paint a zero refusal count in the colour of a refusal', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		render(Page, { data: DATA, form: formWith() });

		// The measured case, stated separately from the agreement above, because two chromes that
		// were BOTH unconditionally rose would satisfy that one.
		for (const chrome of tonesPerChrome()) {
			expect(chrome.filter((tone) => tone.startsWith('text-rose'))).toEqual([]);
		}
	});

	it('still marks a real refusal, so the gate is not simply the colour removed', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		render(Page, { data: DATA, form: formWith({ invalidRows: 3, importedRows: 5 }) });

		for (const chrome of tonesPerChrome()) {
			expect(chrome.filter((tone) => tone.startsWith('text-rose'))).toHaveLength(1);
		}
	});
});
