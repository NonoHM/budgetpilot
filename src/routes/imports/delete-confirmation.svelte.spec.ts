import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../layout.css';
import * as m from '$lib/paraglide/messages';

import Page from './+page.svelte';
import type { PageData } from './$types';

/**
 * A9: the confirmation names what it is about to destroy.
 *
 * ## The fixture is the argument
 *
 * Two batches that agree on every attribute this page displays except one. Same file name, same
 * profile, same period, same four counts, same recognised-columns block. That is not a contrived
 * pair: it is what `/imports` holds the moment a user corrects a mapping and imports the same
 * statement again, which is the state this wave produces on purpose, and it is also what the
 * withheld case of the replace deliberately leaves behind. The only thing that tells them apart is
 * `createdAt`.
 *
 * So a fixture with two different file names would let a confirmation titled by file name pass
 * while failing at the one moment it is needed. The pair is chosen for what it DISTINGUISHES.
 *
 * The two timestamps are forty seconds apart IN THE SAME MINUTE, and that is the boundary rather
 * than a convenience. It was measured on the real journey: two imports of the same statement, one
 * of them a correction of the other, land in the same minute often enough that a page rendering
 * `timeStyle: 'short'` showed both rows as « 17 août 2026 à 14:10 » and titled the confirmation
 * with a string that named both. Two timestamps hours apart would have passed every assertion
 * below against a page that cannot tell apart the pair it exists to tell apart.
 *
 * `expect(older).not.toBe(newer)` in the first test is the calibration for exactly that: it fails
 * on a page whose rendering is too coarse for its own fixture, rather than letting the rest pass
 * for the wrong reason.
 *
 * ## And the seam
 *
 * Two call sites open this dialog, one per chrome, each building the object the dialog reads. A
 * spec asserting the dialog renders the title it is given says nothing about whether either call
 * site passes the timestamp, and a chrome that forgot it would ship a title reading "undefined" at
 * one width only. Both are exercised below, at the width where each exists.
 *
 * ## What each of these would have taken to make red
 *
 * Measured, because a green says nothing until that is known, and because only ONE of the five was
 * red before the change: the other four could not see the defect they exist for. A message that
 * takes no parameter still accepts one and ignores it, so every assertion comparing the title
 * against `imports_cancel_confirm_title({ date })` agreed with the un-parameterised constant on
 * both sides. Their meaning starts at this change, and their green before it is worth nothing.
 *
 *  - title reverted to a constant: 3 red, this file's whole point.
 *  - the mobile card stops passing `createdAt`: 1 red, and it is the seam test. The desktop tests
 *    stay green, which is the shape of the defect a single-chrome spec ships.
 *  - the title formatted from the raw ISO instead of the page's `formatDate`: 3 red.
 *  - the file name appended to the title: 3 red.
 *  - the dismiss returned to « Annuler »: 1 red, and only the verb test.
 *  - the page's `formatDate` returned to minute precision: 1 red, and it is the calibration inside
 *    the first test rather than any of the title assertions. Worth recording, because it says the
 *    other four are BLIND to a discriminant that identifies both candidates: they compare the
 *    title against the row, and a title too coarse to be unique still agrees with a row that is
 *    equally coarse. Two things reading the same wrong value agree.
 */

const OLDER_AT = '2026-07-01T08:59:05.000Z';
const NEWER_AT = '2026-07-01T08:59:45.000Z';
const SHARED_FILE = 'releve-juin.csv';

function batch(id: string, createdAt: string) {
	return {
		id,
		fileName: SHARED_FILE,
		source: 'FILE',
		profile: 'generic',
		rowCount: 30,
		importedRows: 30,
		duplicateRows: 0,
		invalidRows: 0,
		periodStart: '2026-06-01',
		periodEnd: '2026-06-30',
		createdAt,
		transactionCount: 30,
		columnMapping: null
	};
}

const DATA = {
	cancelled: false,
	collisions: [],
	batches: [batch('batch-newer', NEWER_AT), batch('batch-older', OLDER_AT)]
} as unknown as PageData;

/**
 * The string this page already shows for that import, read back out of the row rather than
 * recomputed here.
 *
 * Recomputing it would mean retyping `formatDate`, and a test that formats its own expectation
 * asserts the copy rather than the page: it would pass in a session whose locale renders something
 * else entirely. The `title` attribute carries the raw ISO, so the handle is the batch's own
 * identity rather than a position in the list.
 */
async function shownDate(iso: string): Promise<string> {
	const cell = page.getByTitle(iso).first();
	return ((await cell.element()).textContent ?? '').trim();
}

function dialogName(): string {
	const dialog = document.querySelector('[role="dialog"]');
	const labelled = dialog?.getAttribute('aria-labelledby');
	return document.getElementById(labelled ?? '')?.textContent?.trim() ?? '';
}

describe('the delete confirmation on the desktop chrome', () => {
	it('names the import the row belongs to, and not the other one', async () => {
		// Separates "the title carries a timestamp" from "the title carries THIS row's timestamp".
		// The older batch is the second row, so a title built from `data.batches[0]`, or from
		// whichever row was rendered last, passes the first half and fails here.
		await page.viewport(1280, 900);
		render(Page, { data: DATA, form: null });

		const older = await shownDate(OLDER_AT);
		const newer = await shownDate(NEWER_AT);
		expect(older).not.toBe(newer);

		await page.getByRole('button', { name: m.common_delete() }).nth(1).click();

		expect(dialogName()).toContain(older);
		expect(dialogName()).not.toContain(newer);
	});

	it('keeps the file name in the body, where it corroborates rather than identifies', async () => {
		// Separates naming from corroborating. The file name is the attribute the two candidates
		// SHARE, so a title carrying it states an identity both satisfy. It is still worth showing:
		// it is what the user recognises, once the dialog has already said which import it means.
		await page.viewport(1280, 900);
		render(Page, { data: DATA, form: null });

		await page.getByRole('button', { name: m.common_delete() }).nth(1).click();

		expect(dialogName()).not.toContain(SHARED_FILE);
		await expect.element(page.getByText(SHARED_FILE).last()).toBeInTheDocument();
	});

	it('says the same thing to a screen reader as it shows on screen', async () => {
		// Separates "a timestamp" from "the timestamp this page renders". The two sides come from
		// different render sites, the row and the dialog title, and the claim is that they cannot
		// disagree. A title formatted by any other call than the page's own `formatDate` reddens
		// this while leaving the test above green, because it would still be that batch's date.
		//
		// It is also what rules out writing 01/07/2026 10:59 in the title: a screen reader reads
		// that as digits and slashes, which cannot be compared button to button, and the row does
		// not say it either.
		await page.viewport(1280, 900);
		render(Page, { data: DATA, form: null });

		await page.getByRole('button', { name: m.common_delete() }).nth(1).click();

		expect(dialogName()).toBe(m.imports_cancel_confirm_title({ date: await shownDate(OLDER_AT) }));
	});

	it('offers no control that calls the deletion an annulation', async () => {
		// The direction this change is not moving in, and the reason the verb was settled rather
		// than only the title parameterised. This wave exists partly to stop "Annuler" naming a
		// deletion, so the dismiss says what it PRESERVES. A dialog that gained back an "Annuler"
		// button would leave every assertion above green.
		await page.viewport(1280, 900);
		render(Page, { data: DATA, form: null });

		await page.getByRole('button', { name: m.common_delete() }).nth(1).click();

		const dialog = document.querySelector('[role="dialog"]');
		const labels = [...(dialog?.querySelectorAll('button') ?? [])].map((b) =>
			(b.textContent ?? '').trim()
		);
		expect(labels).toContain(m.imports_cancel_confirm_label());
		expect(labels).toContain(m.imports_cancel_keep_label());
		expect(labels).not.toContain(m.common_cancel());
	});
});

describe('the delete confirmation on the mobile chrome', () => {
	it('is given the same target by the card as by the table row', async () => {
		// THE SEAM, at the second call site. The dialog is one component and the two chromes each
		// build the object it reads, so this is the width at which a forgotten field ships.
		//
		// REACHED BY NAME, and that is #380 closing rather than a style change. This used to read
		// `.nth(1)`, because the only handle was a disclosure labelled with the FILE NAME, which both
		// cards share: there was no non-positional way to say which row was meant. A selector that has
		// to count is usually reporting something about the page, and it was. Planche 5e removes the
		// disclosure and names the control by the timestamp, so the row can be named.
		await page.viewport(390, 844);
		render(Page, { data: DATA, form: null });

		const older = await shownDate(OLDER_AT);
		await page.getByRole('button', { name: `Supprimer l'import du ${older}` }).click();

		expect(dialogName()).toBe(m.imports_cancel_confirm_title({ date: await shownDate(OLDER_AT) }));
	});
});

/**
 * Planche 5e, reported from the delete plate without reopening it.
 *
 * Three states circulated for one action: red words on desktop, a « ··· » disclosure in the tested
 * build, and a 32 px bordered red bin in the design file. Brique 1's own « Remplace » section names
 * imports, bin included, so the mobile chrome was applying the referential and it is the desktop
 * and its word that diverged.
 *
 * The fixture is the same pair as above, and it is the argument here too: two cards agreeing on
 * every visible attribute except the timestamp is what `/imports` holds after a correction.
 */
/**
 * Both chromes are mounted at once (`hidden lg:block` and `lg:hidden`), so a bare document query
 * returns FOUR controls for two imports and every count assertion below would be about the markup
 * rather than about what a user can reach. `offsetParent` is null for a `display:none` subtree, so
 * this returns exactly the chrome the viewport is showing.
 *
 * Measured: the first version of these tests read four and asserted two, which reads like a
 * duplicate-rendering defect and is a fact about the test's scope.
 */
function visibleDeleteControls(): HTMLElement[] {
	return [
		...document.querySelectorAll<HTMLElement>('button[aria-label^="Supprimer l\'import"]')
	].filter((el) => el.offsetParent !== null);
}

describe('the destructive control on the import card', () => {
	// THE ASSERTION IS THAT THE NAMES DIFFER, not that each card has one. « Each has a name » is
	// satisfied by the measured defect, where both disclosures were called « Supprimer releve.csv ».
	// The absolute count sits beside the uniqueness claim so a selector matching nothing cannot pass.
	it('gives two lookalike cards two different names', async () => {
		await page.viewport(390, 844);
		render(Page, { data: DATA, form: null });

		const names = visibleDeleteControls().map((b) => b.getAttribute('aria-label'));

		expect(names).toHaveLength(2);
		expect(new Set(names).size).toBe(2);
	});

	// The discriminant is the TIMESTAMP, which is the attribute the two candidates do not share, and
	// it is the same string the row and the confirmation use. The file name stays out of the name:
	// it is what both satisfy.
	it('names each card by the timestamp its row already shows', async () => {
		await page.viewport(390, 844);
		render(Page, { data: DATA, form: null });

		const older = await shownDate(OLDER_AT);
		const control = visibleDeleteControls().find(
			(b) => b.getAttribute('aria-label') === `Supprimer l'import du ${older}`
		);

		expect(control).toBeDefined();
		expect(control!.getAttribute('aria-label')).not.toContain(SHARED_FILE);
	});

	// The disclosure is gone, and with it the name that lied: it was called « Supprimer <file> » and
	// deleted nothing. An absolute zero, because « no disclosure » is satisfied by a selector that
	// matches nothing, so the count above is what proves the query works.
	it('leaves no expand disclosure on any card', async () => {
		await page.viewport(390, 844);
		render(Page, { data: DATA, form: null });

		expect(document.querySelectorAll('button[aria-expanded]')).toHaveLength(0);
	});

	// The control opens the confirmation directly. Two presses for a rare action protect nothing,
	// they hide; and the plate's acceptance of an icon-only control is CONDITIONAL on this modal
	// carrying the words.
	it('opens the confirmation in one press', async () => {
		await page.viewport(390, 844);
		render(Page, { data: DATA, form: null });

		const older = await shownDate(OLDER_AT);
		await page.getByRole('button', { name: `Supprimer l'import du ${older}` }).click();

		expect(dialogName()).toContain(older);
	});

	// The desktop loses its word and takes the same component. A divergence tolerated is a
	// divergence that grows, and this one is the documented origin of the whole chantier.
	it('is the same icon control at 1280, with no text label and no tooltip', async () => {
		await page.viewport(1280, 900);
		render(Page, { data: DATA, form: null });

		const controls = visibleDeleteControls();
		expect(controls).toHaveLength(2);
		for (const control of controls) {
			expect(control.textContent?.trim()).toBe('');
			// No tooltip: information reserved to the desktop is a new divergence born the same way
			// the first one was.
			expect(control.hasAttribute('title')).toBe(false);
		}
	});

	// Neutral at rest, and the plate's second reason is the stronger one: this card already spends
	// red 25 px away, on the « Invalides » counter when it is non-zero. A third red in one glance
	// weakens the one that informs in favour of the one that decorates.
	it('rests neutral rather than red', async () => {
		await page.viewport(390, 844);
		render(Page, { data: DATA, form: null });

		const control = visibleDeleteControls()[0];

		const probe = document.createElement('div');
		probe.className = 'text-zinc-700';
		document.body.appendChild(probe);
		expect(getComputedStyle(control).color).toBe(getComputedStyle(probe).color);
		probe.remove();
	});
});
