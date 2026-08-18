import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import '../../layout.css';
import * as m from '$lib/paraglide/messages';
import {
	clearPendingDesignation,
	setPendingDesignation
} from '$lib/import/pendingDesignation.svelte';
import type { DesignationFile, RoleAssignment } from '$lib/domain/columnDesignation';

const navigation = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: navigation.goto
}));

import Page from './+page.svelte';

/**
 * THE WAY OUT of the designation screen, which is a different question from what it carries.
 *
 * ## Why this file exists at all
 *
 * `correction-consent.svelte.spec.ts` proves `/import` hands the correspondance id over. That is the
 * carry. Nothing proved this route USES it, and the gap was measured rather than reasoned: breaking
 * `onCancel` back to a bare `goto('/import')` — which is exactly how it shipped — left every test in
 * this repository green. A field carried and never read is the same as a field not carried, and only
 * a test at this level can tell the two apart.
 *
 * ## The defect, walked in a browser on 2026-08-17
 *
 * « Annuler » and the header's back chevron both went to `/import` with no query string. On a
 * correction that dropped `?correct=` and `?batch=`, so the correction notice and the delete checkbox
 * were gone. The obvious next action from there — pick the file, press Import — re-read the statement
 * through the very correspondance the user came to fix, and imported it a second time with nothing
 * saying so.
 *
 * Reload and browser-back land on the same bare page and are NOT fixed here: `pendingDesignation` is
 * read-once, so by the time either arrives there is nothing left to rebuild an address from. Filed.
 */

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

/** Ids chosen so they could not be confused for one another in an assertion. */
const MAPPING = 'mapping-being-corrected';
const BATCH = 'batch-being-replaced';

function seed(correction: { mappingId: string; batchId: string } | null) {
	// The naming fields are fixture noise here and are filled once: this file is about the WAY OUT,
	// which reads only the two ids. Planche 5c added the other three so the footer can name what it
	// would delete, and a test about navigation has nothing to say about them.
	setPendingDesignation({
		file: new File(['Jour;Intitule;Somme\n'], 'releve.csv', { type: 'text/csv' }),
		view: VIEW,
		initialAssignment: ASSIGNMENT,
		candidates: {},
		correction: correction
			? { ...correction, namedAt: '1 juillet 2026 à 10:59', replacedRows: 25, hasUserWork: false }
			: null
	});
}

beforeEach(() => {
	clearPendingDesignation();
	vi.clearAllMocks();
});

describe('leaving the designation screen', () => {
	it('returns to the correction it came from, with both ids', async () => {
		await page.viewport(390, 844);
		seed({ mappingId: MAPPING, batchId: BATCH });
		render(Page, { form: null } as never);

		await userEvent.click(
			page.getByRole('button', { name: m.import_columns_cancel() }).element() as HTMLElement
		);

		// Both ids, in one assertion, because either alone reopens the wrong thing: without the
		// correspondance the screen does not know it is a correction, and without the batch it corrects
		// without replacing.
		expect(navigation.goto).toHaveBeenCalledWith(`/import?correct=${MAPPING}&batch=${BATCH}`);
	});

	it('returns to the plain upload when the run is not a correction', async () => {
		// The direction this is not moving in, and the common one. A query string built unconditionally
		// would send every ordinary import to `/import?correct=&batch=`, which the load would resolve to
		// nothing and render as an ordinary form — right by accident, and wrong the day the load starts
		// refusing an empty id.
		await page.viewport(390, 844);
		seed(null);
		render(Page, { form: null } as never);

		await userEvent.click(
			page.getByRole('button', { name: m.import_columns_cancel() }).element() as HTMLElement
		);

		expect(navigation.goto).toHaveBeenCalledWith('/import');
	});

	it('leaves the same way from the header, which is the control most people press', async () => {
		// Two controls, one route out, and they are separate elements. The chevron is an IconButton in
		// the header and « Annuler » is in the footer; wiring one and not the other is invisible to a
		// test that only presses the other.
		await page.viewport(390, 844);
		seed({ mappingId: MAPPING, batchId: BATCH });
		render(Page, { form: null } as never);

		await userEvent.click(
			page.getByRole('button', { name: m.import_columns_back() }).element() as HTMLElement
		);

		expect(navigation.goto).toHaveBeenCalledWith(`/import?correct=${MAPPING}&batch=${BATCH}`);
	});
});
