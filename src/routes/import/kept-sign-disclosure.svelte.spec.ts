import { describe, it, expect, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../layout.css';
import { setCompletedImport, takeCompletedImport } from '$lib/import/completedImport.svelte';
import type { ImportSummaryResult } from '$lib/domain/importSummary';
import Page from './+page.svelte';
import type { PageData } from './$types';

/**
 * #1294, THE KEPT SIGN ANSWER DISCLOSED on the summary, owner ruling 2: a statement imported with no
 * question because a kept « money out / money in » answer decided every row says so, beside the
 * line that names where the rows went, with a link that reopens the correspondance to answer again.
 *
 * Strings are literal French on purpose (the cookie is pinned to `fr`): reading them from the
 * catalogue would assert the catalogue against itself. The page renders its content once per chrome
 * (`hidden lg:block`, `lg:hidden`); DOM order is the discriminator, desktop first.
 */
const BASE: ImportSummaryResult = {
	fileName: 'releve.csv',
	profile: 'mapped',
	totalRows: 3,
	importedRows: 3,
	invalidRows: 0,
	fileLevelRefusals: 0,
	duplicateRows: 0,
	autoCategorizedRows: 0,
	mirrorRows: 0,
	totalDebitCents: 12710,
	totalCreditCents: 0,
	period: { from: '2026-06-15', to: '2026-06-24' },
	batchId: 'batch-7',
	invalidRowDetails: [],
	hiddenInvalidRowsCount: 0,
	accountName: 'Compte courant',
	rememberedMapping: false,
	dateOrderDisclosure: null,
	keptAmountSign: { sign: 'out', mappingId: 'mapping-3' }
};

const DATA: PageData = { user: null, correction: null };
const OUT = 'Montants enregistrés comme argent sorti, votre réponse précédente pour ce compte.';
const IN = 'Montants enregistrés comme argent entré, votre réponse précédente pour ce compte.';
const LINK = 'Changer la lecture des montants';

beforeEach(() => {
	takeCompletedImport();
});

async function show(importResult: ImportSummaryResult) {
	setCompletedImport({
		importResult,
		capReached: false,
		canRevisit: false,
		replaced: { kind: 'none' }
	});
	await render(Page, { data: DATA, form: null });
}

const lines = () => page.getByTestId('kept-sign-line');
const links = () => page.getByRole('link', { name: LINK });

describe('a kept sign answer is disclosed on the summary', () => {
	/**
	 * Separates « the sentence and its link reached the desktop chrome, and the link reopens THIS
	 * correspondance for THIS batch » from « drawn in one chrome only » or « a link to the recap ».
	 */
	it('says it at 1280, with the link to answer again', async () => {
		await page.viewport(1280, 800);
		await show(BASE);

		await expect.element(lines().first()).toHaveTextContent(OUT);
		await expect.element(links().first()).toBeVisible();
		expect(links().first().element().getAttribute('href')).toBe(
			'/import?correct=mapping-3&batch=batch-7&step=sign'
		);
	});

	/** The mobile chrome, at the width it is drawn for, with a target a thumb can reach (44 px). */
	it('says it at 390, the link 44 px tall', async () => {
		await page.viewport(390, 844);
		await show(BASE);

		await expect.element(lines().last()).toHaveTextContent(OUT);
		await expect.element(links().last()).toBeVisible();
		expect(links().last().element().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
	});

	/** The sibling answer, so the test cannot pass on a hard-coded sentence. */
	it('says money in for a kept « in »', async () => {
		await page.viewport(1280, 800);
		await show({ ...BASE, keptAmountSign: { sign: 'in', mappingId: 'mapping-3' } });

		await expect.element(lines().first()).toHaveTextContent(IN);
	});

	/**
	 * Separates « no kept answer decided the rows, nothing said » from « a line on every summary »:
	 * the first statement, answered on screen, and a file whose own signs decided.
	 */
	it('says nothing when no kept answer decided the rows', async () => {
		await page.viewport(1280, 800);
		await show({ ...BASE, keptAmountSign: null });

		await expect.element(page.getByText('Fichier importé : releve.csv').first()).toBeVisible();
		expect(lines().elements()).toHaveLength(0);
		expect(links().elements()).toHaveLength(0);
	});
});

/**
 * #1305: the page the link lands on says what the member came for, in the link's own words, and why
 * the file is asked again. Separates « the purpose is named on arrival » from the generic correction
 * notice, which a member read as the link having failed.
 */
describe('the page the link lands on', () => {
	const correction = (step: 'sign' | null) =>
		({
			user: null,
			correction: {
				mappingId: 'mapping-3',
				batchId: 'batch-7',
				replacedAt: '2026-06-24T08:00:00.000Z',
				replacedRows: 2,
				hasUserWork: false,
				step
			}
		}) as unknown as PageData;
	/** Copies a member can see: the page draws each chrome, and one is hidden at each width. */
	const shown = (text: string) =>
		page
			.getByText(text, { exact: true })
			.elements()
			.filter((element) => element.checkVisibility()).length;

	it('names the change and why the statement is asked again', async () => {
		await page.viewport(390, 844);
		await render(Page, { data: correction('sign'), form: null });
		await expect.poll(() => shown(LINK)).toBe(1);
		expect(
			shown('Les relevés ne sont pas conservés après l’import : choisissez de nouveau celui-ci.')
		).toBe(1);
	});

	it('keeps the column correction notice for the recap link', async () => {
		await page.viewport(390, 844);
		await render(Page, { data: correction(null), form: null });
		await expect
			.poll(() => shown('Les désignations mémorisées s’ouvrent pour être corrigées.'))
			.toBe(1);
		expect(page.getByText(LINK, { exact: true }).elements().length).toBe(0);
	});
});
