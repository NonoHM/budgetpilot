import { describe, it, expect, vi } from 'vitest';
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
 * against `imports_delete_confirm_title({ date })` agreed with the un-parameterised constant on
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

		expect(dialogName()).toBe(m.imports_delete_confirm_title({ date: await shownDate(OLDER_AT) }));
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
		expect(labels).toContain(m.imports_delete_confirm_label());
		expect(labels).toContain(m.imports_delete_keep_label());
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

		expect(dialogName()).toBe(m.imports_delete_confirm_title({ date: await shownDate(OLDER_AT) }));
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

/**
 * THE RULE OF PLANCHE 5f, asserted at the route because that is where the behaviour lives.
 *
 * The plate states it as a test consequence rather than leaving it implied: « un test qui ferme la
 * modale sur l'appui verrouille le défaut. L'assertion à écrire est que la modale est encore montée
 * après une réponse d'erreur, et que la rangée est encore dans la liste. »
 *
 * `fetch` is stubbed because `use:enhance` posts through it, and what is asserted is what the page
 * does with the answer. A mock's call count would assert the plumbing; the mounted dialog and the
 * surviving row are what a user sees.
 */
describe('the delete that is refused', () => {
	it('leaves the dialog mounted, with the row still in the list', async () => {
		await page.viewport(390, 844);
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ type: 'failure', status: 500, data: '{"error":"boom"}' }), {
						status: 500,
						headers: { 'content-type': 'application/json' }
					})
			)
		);
		render(Page, { data: DATA, form: null });

		const older = await shownDate(OLDER_AT);
		await page.getByRole('button', { name: `Supprimer l'import du ${older}` }).click();
		// Scoped to the dialog and matched exactly: « Supprimer » is a SUBSTRING of every card
		// control's name (« Supprimer l'import du ... »), so an unscoped match resolves to three.
		await page
			.getByRole('dialog')
			.getByRole('button', { name: m.imports_delete_confirm_label(), exact: true })
			.click();

		// Both halves, because either alone is satisfied by the defect: a dialog that closed would
		// leave the row too, and a row that vanished optimistically would leave the dialog.
		await expect.element(page.getByRole('alert')).toBeInTheDocument();
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect(visibleDeleteControls()).toHaveLength(2);

		vi.unstubAllGlobals();
	});

	// NO OPTIMISTIC REMOVAL, stated as its own assertion. Seeing a row disappear and come back is a
	// more expensive lie than the wait, on financial data.
	it('never removes the row before the answer', async () => {
		await page.viewport(390, 844);
		let resolveFetch: (value: Response) => void = () => {};
		vi.stubGlobal(
			'fetch',
			vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve)))
		);
		render(Page, { data: DATA, form: null });

		const older = await shownDate(OLDER_AT);
		await page.getByRole('button', { name: `Supprimer l'import du ${older}` }).click();
		(
			[...document.querySelectorAll('[role="dialog"] button')].find((b) =>
				b.textContent?.includes(m.imports_delete_confirm_label())
			) as HTMLElement
		).click();
		await new Promise((r) => setTimeout(r, 0));

		// In flight: the row is still there and the dialog is locked.
		expect(visibleDeleteControls()).toHaveLength(2);
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();

		// Settled before the test ends, and awaited: a promise left hanging is reported as an unhandled
		// rejection at teardown, which is noise that reads like a defect in the page.
		resolveFetch(
			new Response(JSON.stringify({ type: 'failure', status: 500, data: '{}' }), {
				status: 500,
				headers: { 'content-type': 'application/json' }
			})
		);
		await new Promise((r) => setTimeout(r, 0));
		vi.unstubAllGlobals();
	});
});

/**
 * THE SECOND FAILURE CLASS, and it exists because a break-check found nothing guarding it.
 *
 * Swapping the no-answer action label for the refusal one reddened NOTHING: the component spec
 * asserts a dialog renders the label it is handed, and no test asserted which label this page hands
 * it. That is the seam again, one wave after the last three instances.
 *
 * The branch is reachable only after 20 s, so the clock is controlled. What is asserted is the
 * observable difference between the two classes: a refusal is retried, a silence is not, because
 * retrying an irreversible action blind is the worst advice a banner can give.
 */
describe('the delete that gets no answer at all', () => {
	it('offers a refresh rather than a retry, unlike a refusal', async () => {
		vi.useFakeTimers();
		await page.viewport(390, 844);
		// A fetch that never settles is the whole fixture: the class under test is the ABSENCE of an
		// answer, which no rejection and no status code can stand in for.
		vi.stubGlobal(
			'fetch',
			vi.fn(() => new Promise<Response>(() => {}))
		);
		render(Page, { data: DATA, form: null });

		const control = visibleDeleteControls()[0];
		control.click();
		await vi.advanceTimersByTimeAsync(0);
		(
			[...document.querySelectorAll('[role="dialog"] button')].find(
				(b) => b.textContent?.trim() === m.imports_delete_confirm_label()
			) as HTMLElement
		).click();

		await vi.advanceTimersByTimeAsync(19_000);
		const beforeThreshold = [...document.querySelectorAll('[role="dialog"] button')].map((b) =>
			b.textContent?.trim()
		);
		// Still in flight at 19 s: the threshold is a threshold, not a delay before giving up.
		expect(beforeThreshold).not.toContain(m.imports_delete_no_answer_action());

		await vi.advanceTimersByTimeAsync(2_000);
		const afterThreshold = [...document.querySelectorAll('[role="dialog"] button')].map((b) =>
			b.textContent?.trim()
		);
		expect(afterThreshold).toContain(m.imports_delete_no_answer_action());
		expect(afterThreshold).not.toContain(m.imports_delete_failed_action());

		vi.unstubAllGlobals();
		vi.useRealTimers();
	});
});

/**
 * The zero case, which is the one branch that had no copy of its own.
 *
 * ## The defect this reproduces
 *
 * A blind walk imported a statement that produced no transactions, then deleted the import. The
 * confirmation read « Ceci supprimera **la 0 transaction** importée par ce relevé », followed by
 * « Les répartitions et les étiquettes ajoutées à ces transactions seront supprimées avec elles ».
 *
 * Neither sentence is French and neither is true. The count selector was `importedRows > 1`, so
 * zero fell to the singular string and interpolated itself into it, and the cost note — which is
 * load-bearing when there ARE transactions, because splits and tags are the user's own work rather
 * than the import's — threatened work that cannot exist for an import that created nothing.
 *
 * A destructive confirmation is exactly where copy carries weight: it is the last screen before an
 * irreversible act, and a reader who catches it saying something false about the small case has no
 * reason to trust it about the large one.
 *
 * ## One is asserted beside zero, and that is the boundary
 *
 * `> 1` and `> 0` disagree on exactly one value, and the singular string is the one both selectors
 * can reach. So the pair below names the single value where the old and new predicates differ, and
 * a fix that merely moved the threshold without giving zero its own sentence fails the first.
 */
describe('the delete confirmation on an import that created nothing', () => {
	function batchWith(importedRows: number) {
		return {
			...batch('batch-empty', OLDER_AT),
			rowCount: 8,
			importedRows,
			transactionCount: importedRows
		};
	}

	function dialogBody(): string {
		return document.querySelector('[role="dialog"]')?.textContent ?? '';
	}

	async function openDeleteFor(importedRows: number) {
		await page.viewport(1280, 900);
		render(Page, {
			data: { ...DATA, batches: [batchWith(importedRows)] } as unknown as PageData,
			form: null
		});
		await page.getByRole('button', { name: m.common_delete() }).first().click();
	}

	it('says the import created nothing, rather than counting to zero in the singular', async () => {
		expect.assertions(2);
		await openDeleteFor(0);

		expect(dialogBody()).toContain(m.imports_delete_confirm_description_count_zero());
		// The measured string, and the reason this is not merely a wording preference: the singular
		// sentence with a zero in it is what shipped.
		expect(dialogBody()).not.toContain(
			m.imports_delete_confirm_description_count_one({ count: 0 })
		);
	});

	it('does not threaten splits and tags that an empty import cannot have', async () => {
		expect.assertions(1);
		await openDeleteFor(0);

		expect(dialogBody()).not.toContain(m.imports_delete_cost_note());
	});

	it('still warns about them at one, which is the value the two selectors disagree on', async () => {
		// The calibration. Suppressing the cost note is a one-character change away from suppressing
		// it everywhere, and it is the sentence that stops a user losing an evening of splitting.
		expect.assertions(2);
		await openDeleteFor(1);

		expect(dialogBody()).toContain(m.imports_delete_cost_note());
		expect(dialogBody()).toContain(m.imports_delete_confirm_description_count_one());
	});
});
