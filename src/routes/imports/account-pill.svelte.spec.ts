import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';

/**
 * WHICH ACCOUNT AN IMPORT LANDED IN, on the list that records imports.
 *
 * ## Why this is a component spec rather than a screenshot
 *
 * The screenshot pass for this task photographed an EMPTY `/imports`: the e2e seed holds no import
 * batch, so the pill had nothing to render and the picture proves nothing about it. Said plainly
 * rather than left as a gap, because a page that renders nothing and a page whose pill is broken
 * produce the same photograph.
 *
 * ## The two states, and the fixture is the argument
 *
 * Both rows below agree on file name, profile, period and every count. They differ in exactly one
 * field, `accountName`, which is the field under test — so nothing else can explain a difference in
 * what renders. One carries a name, the other is null, which is the legitimate state of a batch
 * imported before `ImportBatch.accountId` existed.
 *
 * Two chromes render this list, one per breakpoint, each building its own row. A spec asserting one
 * of them says nothing about the other, and a chrome that forgot the pill would ship a list that
 * names the account at 1280 and not at 390. Both are exercised, at the width where each exists.
 */

const NAMED = 'BP ···4417';

function batch(id: string, accountName: string | null) {
	return {
		id,
		fileName: 'releve-juin.csv',
		source: 'FILE',
		profile: 'generic',
		rowCount: 30,
		importedRows: 30,
		duplicateRows: 0,
		invalidRows: 0,
		periodStart: '2026-06-01',
		periodEnd: '2026-06-30',
		createdAt: '2026-07-01T08:59:05.000Z',
		transactionCount: 30,
		accountName,
		columnMapping: null
	};
}

const DATA = {
	cancelled: false,
	collisions: [],
	batches: [batch('batch-named', NAMED), batch('batch-legacy', null)]
} as unknown as PageData;

describe('the /imports list names the account each import landed in', () => {
	/**
	 * BOTH CHROMES ARE IN THE DOM AT EVERY WIDTH, hidden from each other by CSS, so a raw element
	 * count spans them and is 2 for one row. That is a fact about the page rather than about the
	 * pill, and a first version of these tests asserted 1 and failed for that reason. Counted per
	 * chrome instead: two occurrences means BOTH chromes render it, which is the claim, and exactly
	 * one of them is visible at any width, which is the other half.
	 */
	it('renders the pill in both chromes, exactly one of them on screen at 1280', async () => {
		// SEPARATES: « both chromes render `accountName` » FROM « one of them forgot it ». A chrome
		// that forgot would ship a list naming the account at 1280 and not at 390, which is exactly
		// the seam the delete-confirmation spec next door already records for this page.
		//
		// Visibility is read with `checkVisibility()` rather than through `.first()`, and that is not
		// a detail: `.first()` is DOM ORDER, which is the desktop chrome, so the 390 test built that
		// way waited fifteen seconds for a hidden element and reported a timeout instead of an
		// answer. A selector that has to count is usually reporting something about the page.
		expect.assertions(3);
		await page.viewport(1280, 800);
		render(Page, { data: DATA, form: null });
		const pills = page.getByText(NAMED, { exact: true }).elements();
		// Two rows in the fixture and exactly ONE carries a name, so two occurrences is one per
		// chrome. Four would mean the pill renders for the legacy row too.
		expect(pills).toHaveLength(2);
		expect(pills.filter((el) => el.checkVisibility())).toHaveLength(1);
		// One pill element per chrome, so the legacy row got none. Text alone cannot say that.
		expect(document.querySelectorAll('[data-testid="import-account-pill"]')).toHaveLength(2);
	});

	it('shows it at 390, where the other chrome is the one on screen', async () => {
		expect.assertions(2);
		await page.viewport(390, 844);
		render(Page, { data: DATA, form: null });
		const pills = page.getByText(NAMED, { exact: true }).elements();
		expect(pills).toHaveLength(2);
		expect(pills.filter((el) => el.checkVisibility())).toHaveLength(1);
	});

	it('says NOTHING for a batch that predates the column, rather than naming no account', async () => {
		// SEPARATES: « the pill is absent » FROM « the pill renders empty, or says `Aucun` ». A batch
		// imported before `ImportBatch.accountId` existed genuinely has no account on record, and a
		// row asserting « aucun compte » would be a claim about where those transactions went. They
		// went somewhere; this list simply does not know where, and the Comptes screen is where the
		// user can look.
		expect.assertions(2);
		await page.viewport(1280, 800);
		render(Page, {
			data: { ...DATA, batches: [batch('only', null)] } as PageData,
			form: null
		});
		// Calibration beside the emptiness: the ROW rendered, so this is a row without a pill rather
		// than a list that failed to draw.
		await expect.element(page.getByText('releve-juin.csv').first()).toBeVisible();
		// Counted as ELEMENTS, not as text, and the break matrix is why. Asserting « the name does
		// not appear » is satisfied by a pill that renders EMPTY, which is a visible chip saying
		// nothing beside a row — worse than no pill, because it looks like an answer.
		expect(document.querySelectorAll('[data-testid="import-account-pill"]')).toHaveLength(0);
	});
});
