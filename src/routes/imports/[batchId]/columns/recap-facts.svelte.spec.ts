import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../../layout.css';
import * as m from '$lib/paraglide/messages';

import Page from './+page.svelte';
import type { PageData } from './$types';

/**
 * A8: this page shows the correspondance as it stands NOW, and it must stop saying otherwise.
 *
 * ## The fixture is A8's own reproduction
 *
 * The memorised column for Libellé is « Opération » and the value this batch's transactions carry
 * is « MD4200 », which is a reference and not a merchant. That pair is not decorative: it is the
 * state the finding was written from. A correspondance was corrected, so the column name is the
 * NEW one, and the thirty transactions of the old import still hold what the OLD one produced. Any
 * fixture whose column name and value agree would let a page that pairs them pass, because a
 * pairing is only visibly false when the two halves disagree.
 *
 * ## Why this file exists beside the two component specs
 *
 * `RoleRow.svelte.spec.ts` proves a row states two facts when it is given two facts, and
 * `ColumnDesignationScreen.states.svelte.spec.ts` proves the screen carries the modify note when it
 * is told to. Neither says the ROUTE hands over either one. That is not a hypothetical: it was
 * measured twice in this wave, at Task 4 where an unconditional cost note left fifteen component
 * tests green, and at Task 5 where the framing left twelve green and reddened only the two seam
 * tests. This route is the only caller that re-asks for the file, so it is the only place the note
 * can be turned on, and turning it on is a page decision that no component spec can see.
 *
 * ## One literal, on purpose
 *
 * `cet import en a tirée` is retyped rather than read from the catalogue, because the catalogue no
 * longer holds it: it is the sentence being retired, and the assertion is that it never comes back.
 * A comparison against a message that no longer exists cannot be written, and one against the
 * message that replaced it would be the constant compared to itself.
 *
 * ## What each of these took to make red, run 2026-08-17
 *
 * Only ONE of the four was red when it was written, and it was not for the reason it looks like:
 * the catalogue was edited before the tests, so the caption test below was green from the start and
 * had to be reddened afterwards by putting the old sentence back. That is recorded rather than
 * quietly fixed, because a test written after the string it asserts is a test whose first green
 * says nothing.
 *
 *  - the recap row pairs again: **two red here**, this file's whole point, plus two in `RoleRow`'s.
 *  - the route stops passing `modifyAsksForFile`: **two red here, and ZERO in the component's own
 *    spec.** That is the seam, in the shape it was measured in twice already this wave: the screen
 *    goes on rendering the note when it is told to, and nothing tells it.
 *  - the old caption restored in `messages/fr.json`: **one red**, and only the caption test.
 *  - the caption rendered after the component instead of inside it, which is how it shipped until
 *    the journey was walked: **one red**, and only the placement test. Every assertion about what
 *    the sentence SAYS stays green over a page where it is below the frame at 1280 and behind the
 *    tab bar at 390. That green is why the placement test is written as containment rather than
 *    folded into the caption test.
 *  - the note moved below the link, or rendered unconditionally: **zero red here.** Correct, and
 *    worth stating: this file asks whether the ROUTE hands the note over, not where the screen puts
 *    it. Both are checked, in the component's spec, by their own breaks.
 */

const MEMORISED_COLUMN = 'Opération';
const IMPORTED_VALUE = 'MD4200';

const DATA = {
	batchId: 'batch-corrected',
	mappingId: 'mapping-1',
	memorisedAt: '2026-08-15T09:00:00.000Z',
	useCount: 2,
	file: {
		name: 'releve-juin.csv',
		headers: ['Date opération', MEMORISED_COLUMN, 'Montant', ''],
		samples: [['17/06/2026'], [IMPORTED_VALUE], ['-6,40 €'], ['']],
		firstRow: ['17/06/2026', IMPORTED_VALUE, '-6,40 €', ''],
		rowCount: 30,
		hasHeaderRow: true
	},
	assignment: { date: 0, label: 1, amount: 2, category: null }
} as unknown as PageData;

function pageText(): string {
	return (document.body.textContent ?? '').replace(/\s+/g, ' ');
}

describe('the memorised-columns page, opened from an import', () => {
	it('no longer claims this import read the columns it shows', async () => {
		// Separates "the caption mentions the correspondance" from "the caption says WHEN the
		// correspondance shown was true". The page reads the mapping live, so the old sentence was
		// a statement about the past made from a row that only knows the present.
		await page.viewport(390, 844);
		render(Page, { data: DATA });

		expect(pageText()).not.toContain('cet import en a tirée');
		expect(pageText()).toContain(m.import_columns_recap_explanation());
	});

	it('gives the rows two labelled facts rather than one pairing', async () => {
		// THE SEAM for `readOnly`. Separates "a row can state two facts" from "this page's rows do".
		// Asserted by order, so a page that reinstated the middot between the memorised column and
		// the imported value reddens even if both labels are still printed somewhere.
		await page.viewport(390, 844);
		render(Page, { data: DATA });

		const text = pageText();
		const columnLabel = text.indexOf(m.import_columns_recap_column_fact({ column: '' }).trim());
		const column = text.indexOf(MEMORISED_COLUMN);
		const valueLabel = text.indexOf(m.import_columns_recap_value_fact({ value: '' }).trim());
		const value = text.indexOf(IMPORTED_VALUE);

		expect(columnLabel).toBeGreaterThanOrEqual(0);
		expect(column).toBeGreaterThan(columnLabel);
		expect(valueLabel).toBeGreaterThan(columnLabel);
		expect(value).toBeGreaterThan(valueLabel);
	});

	it('says the file will be asked for again, which only this route knows', async () => {
		// THE SEAM for `modifyAsksForFile`. The screen renders this note when it is told to, and the
		// same screen opened over a file still in hand must not: telling it is a decision about the
		// route, taken here, and invisible to every test in the component's own file.
		await page.viewport(390, 844);
		render(Page, { data: DATA });

		expect(pageText()).toContain(m.import_columns_recap_modify_note());
	});

	it('draws the caption in the column that draws the card, at both widths', async () => {
		// Separates "the page renders the sentence" from "the sentence is read with the rows it is
		// about". Rendered after the component instead of inside it, both earlier assertions stay
		// green and the journey shows the cost: at 1280 the paragraph falls below the frame's border
		// and centres on a different axis from the card, and at 390 it lands under the action footer,
		// behind the tab bar, on a screen whose own body does not scroll.
		//
		// Containment rather than coordinates, because a position measured here would be a fact about
		// the runner's window. What has to hold is which region owns it, and the two regions are
		// different elements per chrome.
		await page.viewport(390, 844);
		const mobile = render(Page, { data: DATA });
		const inBody = mobile.container.querySelector(
			'[data-testid="designation-body"] [data-testid="designation-recap-caption"]'
		);
		expect(inBody?.textContent).toContain(m.import_columns_recap_explanation());
		mobile.container.remove();

		await page.viewport(1280, 900);
		const desktop = render(Page, { data: DATA });
		const inCommand = desktop.container.querySelector(
			'[data-testid="designation-command"] [data-testid="designation-recap-caption"]'
		);
		expect(inCommand?.textContent).toContain(m.import_columns_recap_explanation());
	});

	it('carries both at 1280, where the screen is a different chrome', async () => {
		// The two chromes are separate branches of the screen, and the recap has shipped a defect at
		// one width before. Separates "the route passes the props" from "the props survive the
		// branch the route is actually rendered in".
		await page.viewport(1280, 900);
		render(Page, { data: DATA });

		const text = pageText();
		expect(text).toContain(m.import_columns_recap_column_fact({ column: MEMORISED_COLUMN }));
		expect(text).toContain(m.import_columns_recap_value_fact({ value: IMPORTED_VALUE }));
		expect(text).toContain(m.import_columns_recap_modify_note());
	});
});
