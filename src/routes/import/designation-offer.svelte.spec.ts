import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import '../layout.css';
import * as m from '$lib/paraglide/messages';
import {
	clearPendingDesignation,
	takePendingDesignation
} from '$lib/import/pendingDesignation.svelte';
import type { DesignationFile } from '$lib/domain/columnDesignation';

const navigation = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: navigation.goto
}));

import Page from './+page.svelte';
import type { PageData } from './$types';

/**
 * The refusal that offers the designation screen, and the two defects the two-button state hid.
 *
 * ## One primary
 *
 * A refused import drew « Désigner les colonnes » inside its offer box AND kept the form's own
 * « Importer le relevé » below it, both full-strength black, the wider one lower down. Worse than a
 * hierarchy problem: the form's `onsubmit` routed EVERY submit to the designation handler once a
 * designation existed, so the button labelled import did not import. Two controls, one behaviour,
 * and the label on the louder one was false.
 *
 * ## And the file could be a different file
 *
 * The picker stays live under the offer. Choosing another statement and pressing on opened the
 * designation screen on the OLD file's name, headers and sample values while carrying the NEW file's
 * bytes. Walked in a browser: the screen said « opaque-02.csv · 3 colonnes » and listed `zone_2a/b/c`
 * with their values, and the server then refused naming « beta » et « gamma » — the other file's
 * headers. Designate against one statement, resolve the indices against another. Where the two order
 * their columns differently that imports amounts as labels, and the measured case only survived
 * because the split-amount guard happened to catch the shape.
 *
 * So the offer is gated on the chosen file being the one the server described, BY IDENTITY. Not by
 * `File.name`: a bank exporting `releve.csv` every month is the ordinary case, and two files sharing
 * a name is exactly when the mismatch matters most.
 *
 * ## What made each red
 *
 *  - the form's `onsubmit` routed to the designation handler again: **2 red**, both « imports rather
 *    than designating » tests. The offer's own button stays green, which is the point of separating
 *    them: it worked before and it works now.
 *  - the offer stops checking the file: **2 red**, both identity tests, at both widths.
 *  - the standing primary keeps `variant="primary"`: **1 red**, the hierarchy test only.
 */

const VIEW: DesignationFile = {
	name: 'releve.csv',
	headers: ['Jour', 'Intitule', 'Somme'],
	samples: [['24/06/2026'], ['MERCERIE'], ['-24,90']],
	previewRows: [['24/06/2026', 'MERCERIE', '-24,90']],
	coverage: [1, 1, 1],
	firstRow: ['24/06/2026', 'MERCERIE', '-24,90'],
	rowCount: 1,
	detectedHeaderRow: true
} as DesignationFile;

const DATA: PageData = {
	user: null,
	correction: null
} as unknown as PageData;

const FORM = { designation: VIEW } as unknown as Record<string, unknown>;

/**
 * The chrome to drive. This page renders its whole content twice, so every locator resolves to two
 * and exactly one is visible; `.first()` is the desktop copy, `display:none` at 390.
 */
function mount(width: number) {
	const rendered = render(Page, { data: DATA, form: FORM as never });
	const sections = rendered.container.querySelectorAll('main > section');
	return (width >= 1024 ? sections[0] : sections[1]) as HTMLElement;
}

const file = (name: string) => new File([`a,b,c\n1,2,3\n`], name, { type: 'text/csv' });

/** Puts a file in the picker AND submits, which is what makes the offer describe that file. */
async function chooseAndSubmit(section: HTMLElement, named = 'releve.csv') {
	const input = section.querySelector('input[type=file]') as HTMLInputElement;
	await userEvent.upload(input, file(named));
	const submit = section.querySelector('button[type=submit]') as HTMLElement;
	await userEvent.click(submit);
}

const offerButtons = () => page.getByRole('button', { name: m.import_columns_offer() });

beforeEach(() => {
	clearPendingDesignation();
	vi.clearAllMocks();
});

describe('the designation offer after a refusal', () => {
	it('shows exactly one primary, and it is not the one that says import', async () => {
		// Separates "both controls exist" from "one of them leads". Read off the rendered background,
		// and calibrated against the offer's own button in the same document: an absence of tint is only
		// believed after the detector has been shown to see one.
		await page.viewport(1280, 800);
		const section = mount(1280);
		await chooseAndSubmit(section);

		const chroma = (element: Element) => {
			const parsed = getComputedStyle(element).backgroundColor.match(/oklch\(([\d.]+)\s+([\d.]+)/);
			return parsed ? Number(parsed[1]) : 1;
		};
		const offer = section.querySelector('button[type=button]') as HTMLElement;
		const standing = section.querySelector('button[type=submit]') as HTMLElement;

		// The offer is the dark one; the standing button is now light. Compared to each other rather
		// than to a literal colour, so a palette change cannot silently invert this.
		expect(chroma(offer)).toBeLessThan(chroma(standing));
	});

	it('imports rather than designating when the standing primary is pressed, at 1280', async () => {
		// THE DEFECT. While this was the form's `onsubmit`, pressing « Importer le relevé » handed the
		// run to the designation screen. Asserted on the handoff NOT happening: the store stays empty
		// and no navigation is issued.
		await page.viewport(1280, 800);
		const section = mount(1280);
		await chooseAndSubmit(section);

		expect(takePendingDesignation()).toBeNull();
		expect(navigation.goto).not.toHaveBeenCalled();
	});

	it('imports rather than designating when the standing primary is pressed, at 390', async () => {
		// A fix applied to one mount and not the other is invisible to any test that does not choose a
		// width, and this page has shipped exactly that defect before.
		await page.viewport(390, 844);
		const section = mount(390);
		await chooseAndSubmit(section);

		expect(takePendingDesignation()).toBeNull();
		expect(navigation.goto).not.toHaveBeenCalled();
	});

	it('opens the designation screen from the offer button, which is the only route in', async () => {
		// The direction this change must not break: the offer worked before and has to keep working.
		await page.viewport(1280, 800);
		const section = mount(1280);
		await chooseAndSubmit(section);

		await userEvent.click(offerButtons().first().element() as HTMLElement);

		expect(takePendingDesignation()?.view.name).toBe(VIEW.name);
		expect(navigation.goto).toHaveBeenCalled();
	});

	it('withdraws the offer once the chosen file is no longer the file it describes, at 1280', async () => {
		// The mismatch, by identity. The replacement file is given the SAME NAME on purpose: a check on
		// `File.name` would pass here and leave the defect standing on the ordinary case of a bank that
		// exports one filename every month.
		//
		// ONE button, not two, and the figure is worth stating rather than guessing: `getByRole` resolves
		// only what is exposed, and the other chrome is `display:none` at this width. A sibling test in
		// `replace-outcome.svelte.spec.ts` counts SIX reason spans across both chromes because
		// `getByText` matches hidden text; these two locators do not agree, and assuming they do is how
		// an absence assertion ends up measuring a breakpoint.
		await page.viewport(1280, 800);
		const section = mount(1280);
		await chooseAndSubmit(section, 'releve.csv');
		expect(await offerButtons().all()).toHaveLength(1);

		const input = section.querySelector('input[type=file]') as HTMLInputElement;
		await userEvent.upload(input, file('releve.csv'));

		expect(await offerButtons().all()).toHaveLength(0);
	});

	it('withdraws the offer once the chosen file is no longer the file it describes, at 390', async () => {
		// The other chrome, driven separately for the reason the mount helper records.
		await page.viewport(390, 844);
		const section = mount(390);
		await chooseAndSubmit(section, 'releve.csv');
		expect(await offerButtons().all()).toHaveLength(1);

		const input = section.querySelector('input[type=file]') as HTMLInputElement;
		await userEvent.upload(input, file('releve.csv'));

		expect(await offerButtons().all()).toHaveLength(0);
	});

	/**
	 * THE TEST THAT CANNOT BE WRITTEN, recorded as a finding rather than left as a gap.
	 *
	 * `designateColumns` also guards on `offersDesignation`, so a designation mixing one file's headers
	 * with another's bytes cannot be constructed even if the button were reached. That guard is
	 * unreachable from any UI path: the same condition removes the button from the document, so there
	 * is nothing left to press. Attempting it drives a detached node and fails inside the locator
	 * rather than on the claim.
	 *
	 * Kept regardless, and this is why it is not dead code: the RENDER gate is a decision about what to
	 * show, and somebody restoring the offer for a replaced file — reasonably, to keep the button
	 * visible and refuse on press — would be removing the only thing that stops the mismatch if the
	 * handler had nothing of its own. Two guards, one condition, one of them deliberately untested.
	 */
});
