import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Page from './+page.svelte';
import type { CsvRefusalFact, CsvRefusalScope } from '$lib/server/import/refusals';
import { refusalLabel } from '$lib/i18n/refusalLabel';

/**
 * The invalid rows table, which is the only place the application explains why an import was
 * refused, and which had NO test that rendered it in a browser before this file existed
 * (#302: the e2e suite uploads a valid file and asserts nothing about refusals).
 *
 * What only a real render can show is the half that lives in markup and is invisible to the
 * typecheck: that a header scoped refusal is not given a transaction row's line number
 * (#291), and that several of them can coexist in one keyed each block without colliding.
 * That second one is a runtime crash, not a type error, and it is what the fabricated
 * `index + 1` was accidentally protecting against.
 *
 * Both breakpoint copies render simultaneously on this page, the shape CLAUDE.md records for
 * /reports and /upcoming-bills, so every assertion below is scoped to the table.
 */

function detail(
	key: number,
	scope: CsvRefusalScope,
	fact: CsvRefusalFact,
	overrides: { field?: string; preview?: string } = {}
) {
	return {
		key,
		scope,
		fact,
		field: overrides.field,
		profile: 'generic',
		preview: overrides.preview ?? ''
	};
}

function formWith(invalidRowDetails: ReturnType<typeof detail>[]) {
	return {
		importResult: {
			fileName: 'releve.csv',
			profile: 'generic',
			totalRows: 4,
			importedRows: 0,
			// Split the way the routes split it: a refusal scoped to the header or the file is not a
			// row, and the page decides where to draw a refusal from exactly this distinction.
			invalidRows: invalidRowDetails.filter((row) => row.scope.kind === 'row').length,
			fileLevelRefusals: invalidRowDetails.filter((row) => row.scope.kind !== 'row').length,
			duplicateRows: 0,
			totalDebitCents: 0,
			totalCreditCents: 0,
			period: null,
			batchId: 'batch-1',
			invalidRowDetails,
			hiddenInvalidRowsCount: 0,
			netWorthLinkStatus: null
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

const DATA = {
	linkableNetWorthAccounts: [],
	hasAllImportBucketsExisting: false
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe('the import invalid rows table', () => {
	it('gives a row scoped refusal its real line number', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		render(Page, {
			data: DATA,
			form: formWith([
				detail(
					0,
					{ kind: 'row', line: 7 },
					{ code: 'invalid-date', column: 'date', value: '01.06.2026' },
					{
						field: 'date',
						preview: 'AUCHAN'
					}
				)
			])
		});

		const table = page.getByRole('table');
		await expect.element(table.getByText('7', { exact: true })).toBeInTheDocument();
		// Through the production label rather than against a retyped copy of the catalogue string.
		// The literal 'date invalide' was here, and it broke the day the string gained the accepted
		// date forms: a test that retypes what it checks asserts the copy, not the behaviour, and
		// the behaviour under test is that a row scoped refusal reaches the table with its reason.
		await expect
			.element(
				table.getByText(refusalLabel({ code: 'invalid-date', column: 'date', value: '01.06.2026' }))
			)
			.toBeInTheDocument();
	});

	/**
	 * A header complaint no longer enters the rows table, and #291's guarantee moved with it.
	 *
	 * It used to render as a table row whose « Ligne » cell read « en-tête », three times over for
	 * one header, which is the reading that made « 3 invalides » look like three bad rows. It is
	 * stated above the counters now. The guarantee is unchanged and its enforcement is stronger:
	 * the block has no line column to fill, so the invented `index + 1` is unrepresentable rather
	 * than merely absent.
	 *
	 * Both breakpoint copies render on this page, so a figure of 2 is one per copy.
	 */
	it('states a header scoped refusal without giving it a line, and opens no rows table', async () => {
		expect.assertions(3);
		await page.viewport(1280, 800);
		render(Page, {
			data: DATA,
			form: formWith([
				detail(
					0,
					{ kind: 'header' },
					{ code: 'unknown-column', column: 'wibble' },
					{
						field: 'colonnes'
					}
				)
			])
		});

		// The reason must reach the user, which is the presence half: without it the two absence
		// assertions below would pass on a page that rendered nothing at all.
		await expect
			.element(page.getByText(refusalLabel({ code: 'unknown-column', column: 'wibble' })).first())
			.toBeInTheDocument();
		expect(
			page.getByText(refusalLabel({ code: 'unknown-column', column: 'wibble' })).elements()
		).toHaveLength(2);
		// No rows were refused, so there is no rows table to draw. The old page drew one and put
		// `1` in its line cell, pointing the user at a transaction row nothing had examined.
		expect(page.getByRole('table').elements()).toHaveLength(0);
	});

	it('renders several header scoped refusals together without colliding', async () => {
		expect.assertions(4);
		await page.viewport(1280, 800);
		// Three header complaints have no line between them. Keyed on the line number, as the
		// table's each block was, they would all share one key: a Svelte duplicate key crash at
		// runtime, invisible to the typecheck because the dependency lives in markup. The block
		// they moved to is keyed the same way and inherits the same hazard.
		render(Page, {
			data: DATA,
			form: formWith([
				detail(0, { kind: 'header' }, { code: 'unknown-column', column: 'alpha' }),
				detail(1, { kind: 'header' }, { code: 'unknown-column', column: 'beta' }),
				detail(2, { kind: 'header' }, { code: 'missing-required-column', role: 'date' })
			])
		});

		await expect
			.element(page.getByText(refusalLabel({ code: 'unknown-column', column: 'alpha' })).first())
			.toBeInTheDocument();
		await expect
			.element(page.getByText(refusalLabel({ code: 'unknown-column', column: 'beta' })).first())
			.toBeInTheDocument();
		// The role reaches the user TRANSLATED. Asserting the raw code would assert the defect.
		await expect
			.element(
				page.getByText(refusalLabel({ code: 'missing-required-column', role: 'date' })).first()
			)
			.toBeInTheDocument();
		// The absolute figure: three refusals in, three list items out per breakpoint copy. A key
		// collision would drop items silently, and asserting only presence would not notice.
		expect(page.getByRole('listitem').elements()).toHaveLength(6);
	});

	/**
	 * The wall the blind session actually met: twenty-five rows carrying one sentence.
	 *
	 * Eight here rather than twenty-five, because the count is what is asserted and eight is
	 * enough to distinguish "collapsed" from "not". The figures are absolute on purpose: a
	 * grouping that silently dropped its members would satisfy "fewer rows than before".
	 */
	it('collapses rows refused for one reason into a single row carrying the count', async () => {
		expect.assertions(4);
		await page.viewport(1280, 800);
		render(Page, {
			data: DATA,
			form: formWith(
				Array.from({ length: 8 }, (_, index) =>
					detail(
						index,
						{ kind: 'row', line: index + 2 },
						{ code: 'invalid-date', column: 'date', value: `0${index + 1}.06.2026` },
						{ field: 'date', preview: `0${index + 1}.06.2026 | Mercerie Lafayette` }
					)
				)
			)
		});

		const table = page.getByRole('table');
		// One header row plus ONE body row, where eight refusals went in.
		expect(table.getByRole('row').elements()).toHaveLength(2);
		await expect.element(table.getByText('8 lignes', { exact: true })).toBeInTheDocument();
		// The reason is still said, once, through the production label.
		await expect
			.element(
				table.getByText(refusalLabel({ code: 'invalid-date', column: 'date', value: '01.06.2026' }))
			)
			.toBeInTheDocument();
		// And every line is still REACHABLE: the reveal names how many it holds. A collapse that
		// discarded its members would pass every assertion above this one.
		await expect.element(table.getByText('Voir les 8 lignes')).toBeInTheDocument();
	});

	it('leaves a lone refusal exactly as it was, with its line number and no reveal', async () => {
		expect.assertions(3);
		await page.viewport(1280, 800);
		render(Page, {
			data: DATA,
			form: formWith([
				detail(
					0,
					{ kind: 'row', line: 4 },
					{ code: 'invalid-date', column: 'date', value: '01.06.2026' },
					{ field: 'date', preview: '01.06.2026 | Mercerie Lafayette' }
				)
			])
		});

		const table = page.getByRole('table');
		await expect.element(table.getByText('4', { exact: true })).toBeInTheDocument();
		await expect.element(table.getByText('01.06.2026 | Mercerie Lafayette')).toBeInTheDocument();
		// The direction this change is not moving in: a single refusal must not acquire a
		// disclosure it has nothing to disclose.
		expect(table.getByText('Voir la ligne').elements()).toHaveLength(0);
	});

	/**
	 * The same collapse at 390, where this screen is a card list rather than a table.
	 *
	 * It is a separate assertion because it was a separate DEFECT: the first version of the
	 * collapse changed only the `<table>`, every test above passed, and the 390 copy went on
	 * rendering eight identical cards. Measured through the route at 390 — eight cards, the offer
	 * to designate the columns pushed above them.
	 *
	 * Both breakpoint copies are in the DOM at once on this page, so the assertion counts the
	 * rendered sentence across the whole document rather than scoping to one of them: the figure
	 * is 2 for a collapsed pair of copies and 16 for an uncollapsed one, which are far enough
	 * apart that the count says which happened.
	 */
	it('collapses the 390 card list too, not only the 1280 table', async () => {
		expect.assertions(2);
		await page.viewport(390, 844);
		render(Page, {
			data: DATA,
			form: formWith(
				Array.from({ length: 8 }, (_, index) =>
					detail(
						index,
						{ kind: 'row', line: index + 2 },
						{ code: 'invalid-date', column: 'date', value: `0${index + 1}/06/26` },
						{ field: 'date', preview: `0${index + 1}/06/26 | Mercerie Lafayette` }
					)
				)
			)
		});

		const sentence = refusalLabel({ code: 'invalid-date', column: 'date', value: '01/06/26' });
		// One per breakpoint copy, not one per rejected row. `exact` on the count marker because
		// a substring match also finds every ancestor that contains it.
		expect(page.getByText(sentence).elements()).toHaveLength(2);
		expect(page.getByText('8 lignes', { exact: true }).elements()).toHaveLength(2);
	});

	it('leaves the field cell empty rather than inventing a value for it', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		// A ROW scoped refusal carrying no field, which is the case that still reaches this table:
		// the file and header scopes moved out of it, and with them the only other way in. The
		// guarantee is the same one, asserted where it can still be violated.
		render(Page, {
			data: DATA,
			form: formWith([detail(0, { kind: 'row', line: 4 }, { code: 'type-amount-mismatch' })])
		});

		const table = page.getByRole('table');
		await expect.element(table.getByText('4', { exact: true })).toBeInTheDocument();
		// `field ?? 'ligne'` used to fill this cell with a word that named no field at all.
		expect(table.getByText('ligne', { exact: true }).elements()).toHaveLength(0);
	});
});
