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
			...overrides
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

/**
 * The three tiles that COUNT rows, in the order both chromes draw them. The two money totals
 * follow and are deliberately excluded below: they are sums, not outcomes, and 0,00 € carries no
 * verdict to get wrong.
 */
type CountKey = 'importedRows' | 'duplicateRows' | 'invalidRows';
const COUNT_KEYS: CountKey[] = ['importedRows', 'duplicateRows', 'invalidRows'];

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

	const ZERO_CASES: Array<[string, Partial<Record<CountKey, number>>]> = [
		['nothing imported', { importedRows: 0, duplicateRows: 8 }],
		['a clean import', {}],
		['rows refused', { invalidRows: 3, importedRows: 5 }]
	];

	it.each(ZERO_CASES)('%s: no figure of zero carries a colour', async (_name, overrides) => {
		// The general property the rose case is one instance of, and the reason it is stated
		// separately: the agreement test above cannot see this one. Both chromes hardcode emerald on
		// « Importées », so they AGREE while both are wrong — « Importées 0 » in the colour of
		// success, on the screen whose headline fact is that nothing was imported.
		//
		// A colour on a summary figure is a verdict about that figure. Zero is the one value where
		// no verdict is available: nothing was imported, nothing was skipped, nothing was refused.
		expect.assertions(2);
		await page.viewport(1280, 800);
		render(Page, { data: DATA, form: formWith(overrides) });

		const defaults: Record<CountKey, number> = {
			importedRows: 8,
			duplicateRows: 0,
			invalidRows: 0
		};
		const values = COUNT_KEYS.map((key) => overrides[key] ?? defaults[key]);
		for (const chrome of tonesPerChrome()) {
			// Only the three COUNT tiles: the two money totals are not outcomes and carry no tone.
			const colouredZeroes = chrome
				.slice(0, COUNT_KEYS.length)
				.filter((tone, index) => tone !== 'none' && values[index] === 0);
			expect(colouredZeroes).toEqual([]);
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
