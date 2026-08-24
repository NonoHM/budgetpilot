import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Page from './+page.svelte';
import * as m from '$lib/paraglide/messages';

/**
 * How the summary PRESENTS its figures, which is a decision the parser cannot make and no server
 * spec can see.
 *
 * The four counters used to sit in one row of tiles with « Lignes lues » first, and two files of
 * documentation stated that the four added up. They do not, and cannot: a file refused for its
 * header has rows and classifies none of them, so there is a real invariant and it is conditional.
 * Rather than defend a sum on the screen, the screen stopped offering one. The rows read left the
 * grid and became a sentence, and there is no total among the tiles to subtract from.
 *
 * **This is the test for the direction the change is NOT moving in.** The wave makes the app count
 * differently, so its parser tests assert new figures; what could be lost here is the figure
 * itself, so every assertion below is that a number still reaches the user, in a place a reader
 * cannot mistake for a summand.
 *
 * Both breakpoint copies render simultaneously on this page, the shape CLAUDE.md records for
 * /reports and /upcoming-bills, so a figure of 2 below is one per copy.
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
			importedRows: 5,
			invalidRows: 3,
			fileLevelRefusals: 0,
			duplicateRows: 0,
			totalDebitCents: 4200,
			totalCreditCents: 0,
			period: null,
			batchId: 'batch-1',
			invalidRowDetails: [],
			hiddenInvalidRowsCount: 0,
			...overrides
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

describe('the import summary states its rows read rather than tiling it', () => {
	it('says how many rows it read, in words, in both breakpoint copies', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		render(Page, { data: DATA, form: formWith() });

		// Built from the fixture's own figure through the catalogue, never typed as a string here:
		// a hardcoded « 8 lignes lues » asserts this test's spelling of the sentence rather than
		// the page's, and would go on passing if the page interpolated the wrong number.
		const sentence = m.import_summary_rows_read_line_many({ count: 8 });

		await expect.element(page.getByText(sentence).first()).toBeInTheDocument();
		expect(page.getByText(sentence).elements()).toHaveLength(2);
	});

	it('agrees with itself on one row, where the plural would be wrong', async () => {
		expect.assertions(1);
		await page.viewport(1280, 800);
		render(Page, { data: DATA, form: formWith({ totalRows: 1, importedRows: 1, invalidRows: 0 }) });

		// The boundary: one is the single value where the two catalogue keys disagree.
		expect(
			page.getByText(m.import_summary_rows_read_line_one({ count: 1 })).elements()
		).toHaveLength(2);
	});

	it('draws five outcome tiles, none of which is a total', async () => {
		expect.assertions(3);
		await page.viewport(1280, 800);
		render(Page, { data: DATA, form: formWith() });

		// Structural rather than by label, because the property is about what the GRID contains: a
		// reader subtracts from a total that sits beside the parts, and the fix was to take the
		// total out of the row rather than to rename it. An assertion on the missing label would
		// also pass on a grid that kept the tile and renamed its heading.
		const grids = Array.from(document.querySelectorAll('[data-testid="import-summary-figures"]'));

		expect(grids).toHaveLength(2); // one per breakpoint copy
		expect(grids.map((grid) => grid.children.length)).toStrictEqual([5, 5]);
		// The presence half, so the count above cannot pass on a page that drew five of something
		// else: the outcome labels are still there and still tiled.
		expect(page.getByText(m.import_stat_imported(), { exact: true }).elements()).toHaveLength(2);
	});
});

/**
 * What a file refused WHOLE is allowed to assert about its rows.
 *
 * ## The defect these reproduce
 *
 * A blind walk uploaded a statement with unnamed columns. The panel said « 8 lignes lues dans ce
 * fichier », then « Importées 0 · Doublons ignorés 0 · Lignes invalides 0 · Total dépenses 0,00 € ·
 * Total revenus 0,00 € », above a red banner reading « Aucune transaction valide à importer ».
 *
 * Two statements on one screen that cannot both be true of those eight rows. « Lignes invalides :
 * 0 » says nothing was wrong with them; the banner says none of them was usable. And the eight
 * fall into no bucket at all, so a reader looking for their rows finds five zeroes and no account
 * of where the rows went.
 *
 * ## Suppressed rather than given a sixth tile
 *
 * `summaryCounts.spec.ts` proves the invariant this rests on: `fileLevelRefusals > 0` implies the
 * parser classified NO row, because it never examined one. A « Refusées : 8 » tile would put a
 * number in a row of outcomes for rows that have no outcome, and would re-offer the arithmetic the
 * grid was deliberately stripped of. The rows are accounted for in words instead, which is the
 * same move the rows-read line already made.
 *
 * The diagnosis above the figures is untouched: « Colonne requise absente : Date » is the one part
 * of this panel that told the user something they could act on.
 */
describe('a file refused whole states what became of its rows instead of tiling zeroes', () => {
	const REFUSED = {
		totalRows: 8,
		importedRows: 0,
		invalidRows: 0,
		duplicateRows: 0,
		fileLevelRefusals: 3,
		totalDebitCents: 0,
		totalCreditCents: 0,
		invalidRowDetails: [
			{
				key: 0,
				scope: { kind: 'header' },
				fact: { code: 'missing-required-column', role: 'date' },
				profile: 'generic',
				preview: ''
			}
		]
	};

	it('draws no outcome grid, because every tile in it would be a zero about an unexamined row', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		render(Page, { data: DATA, form: formWith(REFUSED) });

		// Structural, for the same reason the five-tile assertion above is: the defect is what the
		// GRID asserts, and a fix that renamed « Lignes invalides » while leaving the row of zeroes
		// would pass a label-based test.
		expect(document.querySelectorAll('[data-testid="import-summary-figures"]')).toHaveLength(0);
		// The half that stops this passing on a panel that renders nothing at all.
		expect(page.getByText(m.import_summary_refused_heading()).elements()).toHaveLength(2);
	});

	it('says the rows were not examined, rather than that they were read', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		render(Page, { data: DATA, form: formWith(REFUSED) });

		// Built through the catalogue from the fixture's own figure, so a page interpolating the
		// wrong count still reddens.
		expect(
			page.getByText(m.import_summary_rows_not_examined_many({ count: 8 })).elements()
		).toHaveLength(2);
		// And the sentence it replaces is gone: « 8 lignes lues » beside a refusal is the claim
		// that produced the contradiction.
		expect(
			page.getByText(m.import_summary_rows_read_line_many({ count: 8 })).elements()
		).toHaveLength(0);
	});

	it('still tiles the outcomes when the rows WERE read, refusals and all', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		// Three bad rows out of eight is not a refused file: the parser read every one of them and
		// classified it, so the tiles are about real outcomes and must stay. Without this, the
		// suppression above is satisfiable by deleting the grid outright.
		render(Page, { data: DATA, form: formWith({ invalidRows: 3, fileLevelRefusals: 0 }) });

		expect(document.querySelectorAll('[data-testid="import-summary-figures"]')).toHaveLength(2);
		expect(
			page.getByText(m.import_summary_rows_read_line_many({ count: 8 })).elements()
		).toHaveLength(2);
	});
});

describe('a file refused whole says so above the figures', () => {
	it('draws the refusal block only when there is a file level refusal', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		render(Page, { data: DATA, form: formWith() });

		expect(page.getByText(m.import_summary_refused_heading()).elements()).toHaveLength(0);

		render(Page, {
			data: DATA,
			form: formWith({
				totalRows: 8,
				importedRows: 0,
				invalidRows: 0,
				fileLevelRefusals: 3,
				invalidRowDetails: [
					{
						key: 0,
						scope: { kind: 'header' },
						fact: { code: 'missing-required-column', role: 'date' },
						profile: 'generic',
						preview: ''
					}
				]
			})
		});

		await expect
			.element(page.getByText(m.import_summary_refused_heading()).first())
			.toBeInTheDocument();
	});
});
