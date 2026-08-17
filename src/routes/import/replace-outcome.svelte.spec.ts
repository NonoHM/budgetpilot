import { describe, it, expect, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../layout.css';
import * as m from '$lib/paraglide/messages';
import { refusalLabel } from '$lib/i18n/refusalLabel';
import { setCompletedImport, takeCompletedImport } from '$lib/import/completedImport.svelte';
import type { ImportSummaryResult, ImportInvalidRowDetail } from '$lib/domain/importSummary';
import Page from './+page.svelte';
import type { PageData } from './$types';

/**
 * What the summary says about the import the correction replaced.
 *
 * ## Why every assertion names a chrome and a width
 *
 * This page renders its whole content TWICE, `hidden lg:block` and `lg:hidden`, so every locator
 * resolves to two elements and exactly one is visible. Selecting `.first()` without pinning the
 * width picks the DESKTOP copy, which at 390 is `display:none`, and the failure reads as "the
 * notice is missing" when it is present and hidden. Driving the two chromes separately is also the
 * only way to see that a change reached BOTH: a notice added to one and not the other is invisible
 * to any test that does not choose. The desktop section is declared first in the document.
 *
 * ## The one thing these tests do NOT check
 *
 * The reason sentence is asserted through `refusalLabel`, the same function the notice calls, so
 * both sides of that comparison come from one place and a wrong sentence INSIDE `refusalLabel`
 * stays green. That is deliberate and it is the lesser of the two available errors: retyping
 * « montant absent » here would assert a French literal that an English locale never renders. What
 * these check is the wiring, that this fact's reason reaches this notice. `refusalLabel`'s own spec
 * is what checks the sentence.
 */

const REFUSAL_FACT = { code: 'invalid-amount', value: '' } as unknown as ImportInvalidRowDetail['fact'];
const OTHER_FACTS = [
	{ code: 'invalid-date', value: 'x' },
	{ code: 'unknown-column', column: 'a' },
	{ code: 'unknown-column', column: 'b' },
	{ code: 'bad-column-count', expected: 3 }
] as unknown as ImportInvalidRowDetail['fact'][];

function refusal(fact: ImportInvalidRowDetail['fact'], key: number): ImportInvalidRowDetail {
	return {
		key,
		scope: { kind: 'row', line: key + 2 },
		fact,
		field: 'amount',
		profile: 'mapped',
		preview: 'x | y'
	} as ImportInvalidRowDetail;
}

function summary(invalidRowDetails: ImportInvalidRowDetail[]): ImportSummaryResult {
	return {
		fileName: 'releve.csv',
		profile: 'mapped',
		totalRows: 30,
		importedRows: 28,
		invalidRows: invalidRowDetails.length,
		duplicateRows: 0,
		totalDebitCents: 4200,
		totalCreditCents: 0,
		period: { from: '2026-07-01', to: '2026-07-31' },
		batchId: 'batch-new',
		invalidRowDetails,
		hiddenInvalidRowsCount: 0,
		netWorthLinkStatus: null
	};
}

const DATA: PageData = {
	user: null,
	correction: null,
	linkableNetWorthAccounts: [],
	hasAllImportBucketsExisting: true
};

const REPLACED_AT = '2026-08-16T08:59:00.000Z';

/**
 * `status`, not `alert`, and the distinction is the component's rather than this test's.
 * `AlertBanner` maps `info` and `success` to a POLITE live region: an assertive one cuts across
 * whatever the reader is in the middle of, which is right for an error blocking their action and
 * wrong for a report about one that already happened. Located on the role the notice really has.
 */
const withheldNotices = () =>
	page.getByRole('status').filter({ hasText: "n’a pas été supprimé" });
const deletedNotices = () => page.getByRole('status').filter({ hasText: 'a été supprimé' });

beforeEach(() => {
	// Read-once by design, so a value left by a previous test would make an assertion about absence
	// pass or fail for the wrong reason.
	takeCompletedImport();
});

describe('the withheld replacement, at both widths', () => {
	function mountWithheld(details: ImportInvalidRowDetail[] = [refusal(REFUSAL_FACT, 0)]) {
		setCompletedImport({
			importResult: summary(details),
			capReached: false,
			canRevisit: false,
			replaced: {
				kind: 'withheld',
				replacedAt: REPLACED_AT,
				replacedRows: 30,
				importedRows: 28
			}
		});
		render(Page, { data: DATA, form: null });
	}

	it('names the import it did NOT delete, at 1280', async () => {
		// The retraction, and it is a different job from explaining the figures. Two screens promise
		// the replacement before any row is counted, and one of them names this import by its date.
		await page.viewport(1280, 800);
		mountWithheld();

		await expect.element(withheldNotices().first()).toBeVisible();
		await expect.element(withheldNotices().first()).toHaveTextContent('16 août 2026');
	});

	it('names the import it did NOT delete, at 390', async () => {
		await page.viewport(390, 844);
		mountWithheld();

		await expect.element(withheldNotices().last()).toBeVisible();
		await expect.element(withheldNotices().last()).toHaveTextContent('16 août 2026');
	});

	it('states BOTH counts, so the user can tell a repair from a loss', async () => {
		await page.viewport(390, 844);
		mountWithheld();

		const notice = withheldNotices().last();
		await expect.element(notice).toHaveTextContent('28');
		await expect.element(notice).toHaveTextContent('30');
	});

	it('names the refusal reason beside the counts', async () => {
		// The figures alone do not tell anybody whether they lost data. What separates a repair from
		// a loss is WHY the rows went, and the app already holds it.
		await page.viewport(390, 844);
		mountWithheld();

		await expect
			.element(withheldNotices().last())
			.toHaveTextContent(refusalLabel(REFUSAL_FACT));
	});

	it('offers the route rather than only the figures', async () => {
		// The user reached the two-row state without choosing it. Figures with no next step is the
		// silence this wave exists to remove.
		await page.viewport(390, 844);
		mountWithheld();

		const link = page
			.getByRole('link', { name: m.import_correct_delete_withheld_action() })
			.last();
		await expect.element(link).toBeVisible();
		await expect.element(link).toHaveAttribute('href', '/imports');
	});

	it('lists at most three reasons and says how many remain', async () => {
		// The cap is a claim about a 390 px screen, so it is asserted rather than commented. Five
		// DISTINCT facts, because groups fold on the reason: five copies of one fact is one group
		// and would pass a broken cap.
		await page.viewport(390, 844);
		mountWithheld([REFUSAL_FACT, ...OTHER_FACTS].map(refusal));

		// SIX: two chromes, three each. Asserted on the TOTAL rather than per chrome, because a cap
		// applied to one chrome and not the other would still show three here, and six is what
		// proves both were capped.
		//
		// Asserted on the count and on the notice's own text rather than on each span's visibility.
		// `toBeVisible` on an individual reason span timed out while the same locator answered
		// `toHaveTextContent` immediately, and the cause turned out to be a real layout defect
		// rather than a matcher quirk: the route link was rendered through `AlertBanner`'s `action`
		// snippet, which puts it on the message's own flex row as a `shrink-0` sibling, and at 390
		// this label took the width and collapsed the message to roughly one word per line. Found by
		// screenshot, fixed by moving the link into the body. The count and the text are what this
		// test is about; the notice's visibility at both widths is the first two tests' claim.
		expect(await page.getByTestId('withheld-reason').all()).toHaveLength(6);

		const notice = withheldNotices().last();
		await expect.element(notice).toBeVisible();
		await expect
			.element(notice)
			.toHaveTextContent(m.import_correct_delete_withheld_reasons_more({ count: 2 }));
	});
});

describe('the two states that are not a withholding', () => {
	it('confirms the deletion by name when it went through', async () => {
		// The user chose this on a control that named no date, so they are owed the confirmation
		// that it was the right import.
		await page.viewport(390, 844);
		setCompletedImport({
			importResult: summary([]),
			capReached: false,
			canRevisit: false,
			replaced: { kind: 'deleted', replacedAt: REPLACED_AT }
		});

		render(Page, { data: DATA, form: null });

		await expect
			.element(deletedNotices().last())
			.toHaveTextContent('16 août 2026');
	});

	it('says NOTHING at all when the run replaced nothing', async () => {
		// The direction this is not moving in, and the one that would go unnoticed. A notice on
		// every import would be worse than the silence it replaces. The common case of the whole
		// wave is also this one: the replacement happened and there is nothing to report.
		await page.viewport(390, 844);
		setCompletedImport({
			importResult: summary([]),
			capReached: false,
			canRevisit: false,
			replaced: { kind: 'none' }
		});

		render(Page, { data: DATA, form: null });

		expect(await withheldNotices().all()).toHaveLength(0);
		expect(await deletedNotices().all()).toHaveLength(0);
	});
});

/**
 * THE CONTROL, at the seam.
 *
 * `CheckboxField.svelte.spec.ts` proves the component renders a note when given one and nothing
 * when not. That is one level down and it says nothing about whether the PAGE gives it one, which
 * is where the owner's condition actually lives: « if the old batch has no splits or tags, say
 * nothing extra rather than warning about a loss that cannot occur ». Measured: making the page
 * pass the note unconditionally left all fifteen tests of the component and the notice GREEN. This
 * block is what that break reddens.
 */
describe('the control that says what it costs, at both widths', () => {
	const CORRECTION = { mappingId: 'mapping-1', batchId: 'batch-old', hasUserWork: false };

	function mountCorrection(correction: PageData['correction']) {
		render(Page, { data: { ...DATA, correction }, form: null });
	}

	const controls = () => page.getByRole('checkbox');
	const costNotes = () => page.getByText(m.imports_cancel_cost_note());

	it('is offered, pre-ticked, at 1280', async () => {
		// Pre-ticked because the default should be the repair the user came for: they arrived from
		// « Modifier les colonnes » on an import they have already decided is wrong.
		await page.viewport(1280, 800);
		mountCorrection(CORRECTION);

		await expect.element(controls().first()).toBeChecked();
	});

	it('is offered, pre-ticked, at 390', async () => {
		await page.viewport(390, 844);
		mountCorrection(CORRECTION);

		await expect.element(controls().last()).toBeChecked();
	});

	it('says NOTHING about splits and tags when the batch carries none', async () => {
		// The owner's one condition on shipping this control. A warning about a loss that cannot
		// occur is discounted every time after, and then it is not read on the run where it is true.
		await page.viewport(390, 844);
		mountCorrection(CORRECTION);

		expect(await costNotes().all()).toHaveLength(0);
	});

	it('names the splits and tags when the batch carries some', async () => {
		// The direction the test above cannot see on its own. Same fixture, one flag different, so
		// the only thing separating the two cases is the flag itself.
		await page.viewport(390, 844);
		mountCorrection({ ...CORRECTION, hasUserWork: true });

		// Two chromes.
		expect(await costNotes().all()).toHaveLength(2);
	});

	it('reuses the sentence the explicit delete already shows', async () => {
		// Located BY that catalogue key rather than by a literal, which is what makes this an
		// anti-drift assertion: a second wording invented here for the same fact would not match,
		// and two screens disagreeing about what a delete costs is the defect it guards.
		await page.viewport(390, 844);
		mountCorrection({ ...CORRECTION, hasUserWork: true });

		await expect.element(costNotes().last()).toBeVisible();
	});

	it('offers no control at all when there is no batch to replace', async () => {
		// A link carrying `?correct=` with no batch, from a bookmark or history. There is nothing to
		// choose, and a ticked box promising a deletion that cannot happen is the defect this wave
		// exists to remove.
		await page.viewport(390, 844);
		mountCorrection({ ...CORRECTION, batchId: null });

		expect(await controls().all()).toHaveLength(0);
	});

	it('offers no control on an ordinary import', async () => {
		await page.viewport(390, 844);
		mountCorrection(null);

		expect(await controls().all()).toHaveLength(0);
	});
});
