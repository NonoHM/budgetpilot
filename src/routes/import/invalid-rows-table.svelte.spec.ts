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
			invalidRows: invalidRowDetails.length,
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
					{ code: 'invalid-date', column: 'date' },
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
			.element(table.getByText(refusalLabel({ code: 'invalid-date', column: 'date' })))
			.toBeInTheDocument();
	});

	it('never prints a line number for a header scoped refusal (#291)', async () => {
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

		const table = page.getByRole('table');
		// The reason must reach the user, which is the presence half: without it, an absence
		// assertion below would pass on a table that rendered nothing at all.
		await expect.element(table.getByText('Colonne non autorisée: wibble')).toBeInTheDocument();
		await expect.element(table.getByText('en-tête', { exact: true })).toBeInTheDocument();
		// The specific damage #291 did: the old page printed `1` here, pointing the user at a
		// transaction row that was never examined, while the problem was in the header.
		expect(table.getByText('1', { exact: true }).elements()).toHaveLength(0);
	});

	it('renders several header scoped refusals together without colliding', async () => {
		expect.assertions(4);
		await page.viewport(1280, 800);
		// Three header complaints have no line between them. Keyed on the line number, as this
		// each block was, they would all share one key: a Svelte duplicate key crash at runtime,
		// invisible to the typecheck because the dependency lives in markup.
		render(Page, {
			data: DATA,
			form: formWith([
				detail(0, { kind: 'header' }, { code: 'unknown-column', column: 'alpha' }),
				detail(1, { kind: 'header' }, { code: 'unknown-column', column: 'beta' }),
				detail(2, { kind: 'header' }, { code: 'missing-required-column', column: 'date' })
			])
		});

		const table = page.getByRole('table');
		await expect.element(table.getByText('Colonne non autorisée: alpha')).toBeInTheDocument();
		await expect.element(table.getByText('Colonne non autorisée: beta')).toBeInTheDocument();
		await expect.element(table.getByText('Colonne requise absente: date')).toBeInTheDocument();
		// The absolute figure: three refusals in, three body rows out. A collision would drop rows
		// silently, and asserting only that some text is present would not notice.
		expect(table.getByRole('row').elements()).toHaveLength(4); // one header row plus three
	});

	it('leaves the field cell empty rather than inventing a value for it', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		render(Page, {
			data: DATA,
			form: formWith([detail(0, { kind: 'file' }, { code: 'file-empty' })])
		});

		const table = page.getByRole('table');
		await expect.element(table.getByText('fichier', { exact: true })).toBeInTheDocument();
		// `field ?? 'ligne'` used to fill this cell with a word that named no field at all.
		expect(table.getByText('ligne', { exact: true }).elements()).toHaveLength(0);
	});
});
