import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import '../layout.css';
import * as m from '$lib/paraglide/messages';
import {
	clearPendingDesignation,
	takePendingDesignation
} from '$lib/import/pendingDesignation.svelte';
import type { DesignationFile, RoleAssignment } from '$lib/domain/columnDesignation';

// Hoisted for the same reason `collision-framing.svelte.spec.ts` records: importing the page pulls
// in `$app/navigation`, and without the mock the failure arrives as a broken IMPORT rather than as
// an assertion.
const navigation = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: navigation.goto
}));

import Page from './+page.svelte';
import type { PageData } from './$types';

/**
 * THE SEAM between the control and the request that deletes.
 *
 * ## The defect these were written against, measured in a browser on 2026-08-17
 *
 * `/import` asks for the consent, and a SECOND press on the same screen hands the run to
 * `/import/columns`. The consent is posted with the first press and echoed back by the server, and
 * the handoff used that echo. So the checkbox went on rendering, went on being interactive, and
 * stopped being read: a user who arrived with it ticked, pressed « Importer le relevé », then
 * changed their mind and unticked it, had their old import deleted anyway and was shown
 * « L'ancien import du ... a été supprimé. » as a confirmation.
 *
 * Walked rather than reasoned: three batches in, untick after the first press, and the batch the
 * user chose to keep was gone from the database with its transactions.
 *
 * ## Why the fixture separates the two batch ids
 *
 * `data.correction.batchId` is what the ADDRESS BAR asked for; `form.correction.batchId` is what
 * the server resolved, checked against this user, and checked against the pairing. Only the second
 * may travel to a request that deletes, and the two are deliberately different strings here. A
 * repair that rebuilt the whole object from `data` would fix the consent and lose that property,
 * and no assertion about the boolean alone could see it.
 *
 * ## What made each red
 *
 *  - the consent read from the server's echo rather than from the control: **two red**, the untick
 *    test and nothing else. The ticked test stays green, which is the point of writing it: it is
 *    the direction the change is not moving in, and it is what stops a repair from inverting the
 *    default that §7b argues for.
 *  - the batch id rebuilt from `data.correction`: **one red**, the id test, and both consent tests
 *    stay green.
 */

const RESOLVED_BATCH = 'batch-resolved-by-the-server';
const REQUESTED_BATCH = 'batch-asked-for-in-the-address-bar';

const VIEW: DesignationFile = {
	name: 'releve.csv',
	headers: ['Jour', 'Intitule', 'Somme'],
	samples: [['24/06/2026'], ['MERCERIE'], ['-24,90']],
	previewRows: [['24/06/2026', 'MERCERIE', '-24,90']],
	coverage: [1, 1, 1],
	firstRow: ['24/06/2026', 'MERCERIE', '-24,90'],
	rowCount: 1,
	hasHeaderRow: true
} as DesignationFile;

const ASSIGNMENT = { date: 0, label: 1, amount: 2, category: null } as unknown as RoleAssignment;

const DATA: PageData = {
	user: null,
	correction: { mappingId: 'mapping-1', batchId: REQUESTED_BATCH, hasUserWork: false },
	linkableNetWorthAccounts: [],
	hasAllImportBucketsExisting: true
} as unknown as PageData;

/** The action's reply to the first press, with the consent as it stood AT THAT PRESS. */
const FORM = {
	designation: VIEW,
	correctingAssignment: ASSIGNMENT,
	correction: { batchId: RESOLVED_BATCH, deleteOldImport: true }
} as unknown as Record<string, unknown>;

/**
 * The chrome to drive, chosen by width.
 *
 * This page renders its form TWICE, `hidden lg:block` and `lg:hidden`, so every locator resolves to
 * two and exactly one is visible. `.first()` is the desktop copy, which is `display:none` at 390.
 */
function mount(width: number) {
	const rendered = render(Page, { data: DATA, form: FORM as never });
	const desktop = width >= 1024;
	const section = rendered.container.querySelectorAll('main > section');
	return (desktop ? section[0] : section[1]) as HTMLElement;
}

/** The file the run carries. `designateColumns` returns early without one, so this is not optional. */
async function chooseFile(section: HTMLElement) {
	const input = section.querySelector('input[type=file]') as HTMLInputElement;
	await userEvent.upload(input, new File(['Jour;Intitule;Somme\n'], 'releve.csv'));
}

beforeEach(() => {
	// Read-once by design, so a value left behind would make an assertion pass for the wrong reason.
	clearPendingDesignation();
	vi.clearAllMocks();
});

describe('the consent that travels to the deleting request', () => {
	it('is the control as it stands at the handoff, not as it stood at the first press', async () => {
		// Separates "the run carries a consent" from "the run carries the CURRENT consent". The
		// fixture's echo says `true`, so a handoff reading the echo passes every other test here.
		await page.viewport(1280, 800);
		const section = mount(1280);
		await chooseFile(section);

		const box = section.querySelector('input[type=checkbox]') as HTMLInputElement;
		expect(box.checked).toBe(true);
		await userEvent.click(box);
		expect(box.checked).toBe(false);

		await userEvent.click(
			page.getByRole('button', { name: m.import_columns_offer() }).first().element() as HTMLElement
		);

		expect(takePendingDesignation()?.correction?.deleteOldImport).toBe(false);
	});

	it('stays true when the control is left as it arrives', async () => {
		// The direction this change is NOT moving in. §7b argues the default is the repair the user
		// came for, and a repair that read the control wrongly in the other direction would leave two
		// imports on every correction with nothing saying so.
		await page.viewport(1280, 800);
		const section = mount(1280);
		await chooseFile(section);

		await userEvent.click(
			page.getByRole('button', { name: m.import_columns_offer() }).first().element() as HTMLElement
		);

		expect(takePendingDesignation()?.correction?.deleteOldImport).toBe(true);
	});

	it('names the batch the SERVER resolved, never the one the address bar asked for', async () => {
		// The property the consent fix must not cost. Both ids are this fixture's own, and they
		// differ, so a handoff rebuilt from `data.correction` reddens here and nowhere else.
		await page.viewport(1280, 800);
		const section = mount(1280);
		await chooseFile(section);

		await userEvent.click(
			page.getByRole('button', { name: m.import_columns_offer() }).first().element() as HTMLElement
		);

		expect(takePendingDesignation()?.correction?.batchId).toBe(RESOLVED_BATCH);
	});

	it('carries the untick from the mobile chrome too', async () => {
		// A fix applied to one mount and not the other is invisible to every test that does not
		// choose a width, and this page has shipped exactly that defect before: `csvFiles` exists
		// because each mount used to hold its own file.
		await page.viewport(390, 844);
		const section = mount(390);
		await chooseFile(section);

		const box = section.querySelector('input[type=checkbox]') as HTMLInputElement;
		await userEvent.click(box);

		await userEvent.click(
			page.getByRole('button', { name: m.import_columns_offer() }).last().element() as HTMLElement
		);

		expect(takePendingDesignation()?.correction?.deleteOldImport).toBe(false);
	});
});
