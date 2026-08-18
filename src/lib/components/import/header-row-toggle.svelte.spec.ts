import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import * as m from '$lib/paraglide/messages';
import type { DesignationFile, RoleAssignment } from '$lib/domain/columnDesignation';

/**
 * « La première ligne contient des données », and the two ways its answer was being lost.
 *
 * ## The defect, measured through the route at 1280 before this file existed
 *
 * A four-line file with no header row was uploaded, the control was clicked, and the columns were
 * designated. The import recorded `rowCount: 3` — **the first transaction was consumed as a
 * header and silently never read** — while the screen went on reading « en-têtes détectés ». The
 * stored mapping was `matchBy: 'name'` with the first data row's VALUES as its column names
 * (`2026-06-01`, `Mercerie Lafayette`, `-45.20`), which is a fingerprint no later file can ever
 * match: dead on arrival, and permanently occupying one slot of a capped table.
 *
 * Two separate faults produced that, and each needs its own assertion because either one alone
 * still loses the row:
 *
 * 1. **`onSubmit` did not carry `hasHeaderRow`.** Its result was `{ assignment, remember }`, so
 *    the user's answer could not leave the component, and the parent posted
 *    `pending.view.hasHeaderRow` — the ORIGINAL detection — every time.
 * 2. **The file meta line read `file.hasHeaderRow`**, the immutable prop, rather than the live
 *    state the toggle mutates. So the screen could not show the flip even locally.
 *
 * The component's own comment already said the answer « must outlive the parent's own guess about
 * the file ». It outlived it inside the component and got no further.
 */

const FILE: DesignationFile = {
	name: 'releve.csv',
	headers: ['2026-06-01', 'Mercerie Lafayette', '-45.20'],
	samples: [['2026-06-01'], ['Mercerie Lafayette'], ['-45.20']],
	firstRow: ['2026-06-01', 'Mercerie Lafayette', '-45.20'],
	rowCount: 3,
	// What DETECTION guessed. The whole point is that the user disagrees with it.
	hasHeaderRow: true
};

const ASSIGNMENT: RoleAssignment = { date: 0, label: 1, amount: 2, category: null };

function open() {
	const submissions: Array<Record<string, unknown>> = [];
	render(ColumnDesignationScreen, {
		file: FILE,
		initialAssignment: ASSIGNMENT,
		candidates: {},
		onSubmit: (result: Record<string, unknown>) => submissions.push(result)
	} as never);
	return submissions;
}

async function clickToggle() {
	// The control lives inside a picker panel, so a role row has to be opened to reach it. That is
	// the real path: there is no other way to it.
	await page
		.getByRole('button', { name: /^Date,/ })
		.first()
		.click();
	// BY ROLE, since Planche 5d made it a switch (brique 6c). A role handle is stronger than the old
	// label match anyway: the label was a sentence stating an action, which is precisely what that
	// section replaced with a subject and a value.
	await page.getByRole('switch').first().click();
}

describe('the first-line-is-data control', () => {
	it('carries the user answer out through onSubmit, not the detection guess', async () => {
		expect.assertions(2);
		await page.viewport(1280, 900);

		const submissions = open();
		await clickToggle();
		await page
			.getByRole('button', { name: m.import_columns_submit_many({ count: FILE.rowCount }) })
			.first()
			.click();

		expect(submissions).toHaveLength(1);
		// `false`, against a file whose detection said `true`. Equality with the PROP is what the
		// old shape would have satisfied by omitting the key entirely.
		expect(submissions[0]).toMatchObject({ hasHeaderRow: false });
	});

	it('says « en-têtes absents » once the user has said so', async () => {
		expect.assertions(2);
		await page.viewport(1280, 900);

		open();
		// The presence half first: without it, the absence assertion below would pass on a screen
		// that rendered no meta line at all.
		await expect
			.element(page.getByText(m.import_columns_headers_detected()).first())
			.toBeInTheDocument();

		await clickToggle();

		await expect
			.element(page.getByText(m.import_columns_headers_absent()).first())
			.toBeInTheDocument();
	});

	/**
	 * The direction this change is NOT moving in: a file whose headers ARE real must still submit
	 * `true`, or every ordinary import starts eating its own header row.
	 */
	it('leaves an untouched screen submitting the detection it arrived with', async () => {
		expect.assertions(1);
		await page.viewport(1280, 900);

		const submissions = open();
		await page
			.getByRole('button', { name: m.import_columns_submit_many({ count: FILE.rowCount }) })
			.first()
			.click();

		expect(submissions[0]).toMatchObject({ hasHeaderRow: true });
	});
});

/**
 * Planche 5d's ARIA decision, asserted as THREE separate claims because they fail for three
 * different reasons: a wrong role is a component bug, a wrong value state is a wiring bug, and
 * membership of the listbox is a tree bug that neither of the first two can see.
 *
 * The fourth is the one that matters most and could not be written before: the listbox's option
 * count. It was announcing one option too many, because a `<button>` that is not an `<option>` was
 * still a child of a `role="listbox"`.
 */
describe('the header toggle is a switch, and it is not an option', () => {
	async function openPicker() {
		await page.viewport(1280, 900);
		open();
		await page
			.getByRole('button', { name: /^Date,/ })
			.first()
			.click();
	}

	it('is a switch', async () => {
		await openPicker();

		await expect.element(page.getByRole('switch').first()).toBeInTheDocument();
	});

	it('carries the value state, which follows the file rather than a guess', async () => {
		await openPicker();

		const control = await page.getByRole('switch').first().element();
		expect(control.getAttribute('aria-checked')).toBe('true');
	});

	it('is no longer a child of the listbox', async () => {
		await openPicker();

		const listbox = document.querySelector('[data-testid="column-listbox"]') as HTMLElement;
		const control = await page.getByRole('switch').first().element();
		// Structural and POSITIVE. Counting options at N rather than N+1 would also pass if the
		// control had simply been deleted, which is not what is being asserted.
		expect(listbox).not.toBeNull();
		expect(listbox.contains(control)).toBe(false);
	});

	it('leaves the listbox announcing exactly one option per column', async () => {
		await openPicker();

		const listbox = document.querySelector('[data-testid="column-listbox"]') as HTMLElement;
		// The absolute figure beside the claim: three headers, three options, and the control is not
		// one of them. Before this it announced four.
		expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(FILE.headers.length);
	});
});
