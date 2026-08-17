import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../layout.css';
import * as m from '$lib/paraglide/messages';
import { setPendingCollision, takePendingCollision } from '$lib/import/pendingCollision.svelte';
import {
	clearPendingDesignation,
	takePendingDesignation
} from '$lib/import/pendingDesignation.svelte';
import type { CollidingBatchView, CollisionFigures } from '$lib/domain/importCollision';
import type { DesignationFile, RoleAssignment } from '$lib/domain/columnDesignation';
// `goto` is stubbed because there is no router in a component test and the real one rejects on
// `undefined.hash`, which surfaces as an unhandled rejection and fails the RUN while every
// assertion passes. Stubbed rather than silenced: the call itself is asserted below, so the
// navigation is still checked, at the only level that can check it without a router.
// The whole module is replaced, so every export the page tree imports has to be present: mocking
// it partially fails the IMPORT rather than an assertion, with "does not provide an export named
// invalidateAll" from a component that has nothing to do with this test.
const navigation = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: navigation.goto
}));

import Page from './+page.svelte';
import type { PageData } from './$types';

/**
 * THE SEAM. `DuplicateStatementDialog.svelte.spec.ts` proves the dialog renders what it is given;
 * this proves the PAGE gives it the right thing, and that is where the behaviour lives.
 *
 * The lesson is one task old and it was measured: passing the correction's cost note
 * unconditionally left fifteen component tests green, because a component spec that proves a
 * component renders a note when given one says nothing about whether its caller gives it one. The
 * same shape applies here exactly. A page that derived the framing from the PRESENCE of a
 * correction rather than from the posted CHOICE would pass every test in the dialog's own file.
 *
 * ## The three states and what separates each pair
 *
 * All three fixtures below are corrections carrying the same batch id. What separates them is one
 * boolean, `deleteOldImport`, and nothing else. That is deliberate: a fixture that also varied the
 * batch id, or the file, would let a wrong derivation pass by reading the wrong field.
 *
 *  - `keeping` against `replacing`: the choice, and only the choice.
 *  - `keeping` against `none`: whether a correction exists at all, with the choice held at false.
 *    This is the pair a batch-id-only carry could not tell apart, since the id is absent in both.
 */

const EXISTING: CollidingBatchView = {
	batchId: 'batch-third',
	fileName: 'releve-juin.csv',
	periodStart: '2026-06-01',
	periodEnd: '2026-06-30',
	transactionCount: 25,
	debitCents: 157928,
	creditCents: 223500,
	createdAt: '2026-08-15T21:50:00.000Z'
};
const INCOMING: CollisionFigures = { ...EXISTING, fileName: 'releve (1).csv' };

const VIEW: DesignationFile = {
	name: 'releve (1).csv',
	headers: ['Jour', 'Intitule', 'Somme'],
	samples: [['24/06/2026'], ['CARREFOUR'], ['-24,90']],
	previewRows: [['24/06/2026', 'CARREFOUR', '-24,90']],
	coverage: [1, 1, 1],
	firstRow: ['24/06/2026', 'CARREFOUR', '-24,90'],
	rowCount: 1,
	hasHeaderRow: true
} as DesignationFile;

const ASSIGNMENT = { date: 0, label: 1, amount: 2, category: null } as unknown as RoleAssignment;

const DATA: PageData = {
	user: null,
	correction: null,
	linkableNetWorthAccounts: [],
	hasAllImportBucketsExisting: true
};

function carry(correction: { batchId: string; deleteOldImport: boolean } | null) {
	setPendingCollision({
		repost: {
			file: new File(['x'], 'releve (1).csv', { type: 'text/csv' }),
			view: VIEW,
			assignment: ASSIGNMENT,
			remember: true,
			hasHeaderRow: true,
			correction
		},
		existing: EXISTING,
		incoming: INCOMING
	});
}

beforeEach(() => {
	// Both modules are read-once by design, so a value left behind would make an assertion about
	// absence pass or fail for the wrong reason.
	takePendingCollision();
	clearPendingDesignation();
	vi.clearAllMocks();
});

describe('the page derives the dialog framing from the posted choice', () => {
	it('says the old import is being KEPT when the control was unticked', async () => {
		await page.viewport(390, 844);
		carry({ batchId: 'batch-old', deleteOldImport: false });

		render(Page, { data: DATA, form: null });

		await expect
			.element(page.getByText(m.import_collision_keeping_body()).last())
			.toBeInTheDocument();
	});

	it('never says the old import is replaced on that same run', async () => {
		// The direction the test above cannot see on its own, and the exact lie a boolean prop would
		// have shipped: the batch id is present here too.
		await page.viewport(390, 844);
		carry({ batchId: 'batch-old', deleteOldImport: false });

		render(Page, { data: DATA, form: null });

		expect(await page.getByText(m.import_collision_replacing_body()).all()).toHaveLength(0);
	});

	it('states the replacement when the control was ticked and a third import matches', async () => {
		await page.viewport(390, 844);
		carry({ batchId: 'batch-old', deleteOldImport: true });

		render(Page, { data: DATA, form: null });

		await expect
			.element(page.getByText(m.import_collision_replacing_body()).last())
			.toBeInTheDocument();
	});

	it('states the DUPLICATION too on that same run, because both facts are true', async () => {
		// The trap in this case. A test asserting the replacement passes having proved nothing about
		// the duplication, and the statement drawn above really would be imported a second time.
		await page.viewport(390, 844);
		carry({ batchId: 'batch-old', deleteOldImport: true });

		render(Page, { data: DATA, form: null });

		await expect
			.element(page.getByText(m.import_collision_consequence()).last())
			.toBeInTheDocument();
	});

	it("leaves today's copy alone when the run is not a correction", async () => {
		await page.viewport(390, 844);
		carry(null);

		render(Page, { data: DATA, form: null });

		await expect
			.element(page.getByText(m.import_collision_explanation()).last())
			.toBeInTheDocument();
		expect(await page.getByText(m.import_collision_keeping_body()).all()).toHaveLength(0);
	});
});

describe('declining keeps the designation work', () => {
	it('hands the screen back its file, its answers and its correction', async () => {
		// Measured in the blind session: declining returned the user to a blank import form, because
		// the page behind the modal had already reset and the carried repost was the only place the
		// answers still existed. Asserted on the STATE the designation screen reads, since that is
		// what decides whether it reopens designated or empty.
		await page.viewport(390, 844);
		carry({ batchId: 'batch-old', deleteOldImport: false });
		render(Page, { data: DATA, form: null });

		await page.getByRole('button', { name: m.import_collision_cancel() }).last().click();

		const kept = takePendingDesignation();
		expect(kept?.initialAssignment).toEqual(ASSIGNMENT);
		expect(kept?.file.name).toBe('releve (1).csv');
		expect(kept?.view.headers).toEqual(VIEW.headers);
		// The field a second attempt cannot do without: losing it would import beside the batch the
		// first attempt was going to replace.
		expect(kept?.correction).toEqual({ batchId: 'batch-old', deleteOldImport: false });
		// And the screen is actually reopened. Seeding the state without navigating would leave the
		// user on a blank upload form holding a designation they cannot see, which is the defect
		// with an extra step rather than the fix.
		expect(navigation.goto).toHaveBeenCalledWith('/import/columns');
	});

	it('hands nothing back when there was nothing carried to hand back', async () => {
		// The direction this is not moving in. A collision raised by `/import`'s own action carries
		// no repost at all, because that run never designated anything: there is no screen to
		// return to, and seeding one would send the user to a designation screen for a file they
		// uploaded through the ordinary form.
		await page.viewport(390, 844);
		render(Page, {
			data: DATA,
			form: { collision: EXISTING, incoming: INCOMING } as unknown as null
		});

		await page.getByRole('button', { name: m.import_collision_cancel() }).last().click();

		expect(takePendingDesignation()).toBeNull();
		expect(navigation.goto).not.toHaveBeenCalled();
	});
});
