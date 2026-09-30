import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import * as m from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import { formatReadingDate } from '$lib/domain/dateFormat';
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
	detectedHeaderRow: true
};

const ASSIGNMENT: RoleAssignment = { date: 0, label: 1, amount: 2, category: null };

async function open() {
	const submissions: Array<Record<string, unknown>> = [];
	await render(ColumnDesignationScreen, {
		file: FILE,
		initialAssignment: ASSIGNMENT,
		candidates: {},
		// A resolved account, because the primary refuses a submission without one. This file measures
		// what the header-row answer does to a submission, so leaving it unchosen would make both
		// tests measure the account guard instead.
		accounts: [
			{ id: 'account-1', name: 'BP · Compte courant', discriminant: '4417', transactionCount: 128 }
		],
		initialAccountId: 'account-1',
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

		const submissions = await open();
		await clickToggle();
		// `rowCount + 1`, and the +1 IS the repair. Declaring the first line data makes it a
		// transaction, so the primary counts it. This locator read `FILE.rowCount` and started timing
		// out the moment the screen stopped promising a figure the server would not honour: measured
		// on the real journey, the button said « Importer 2 lignes » and the summary reported
		// « 3 lignes lues dans ce fichier ».
		await page
			.getByRole('button', { name: m.import_columns_submit_many({ count: FILE.rowCount + 1 }) })
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

		await open();
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

		const submissions = await open();
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
		await open();
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

/**
 * THE FALSE FIGURE THE CONTROL USED TO LEAVE ON THE PRIMARY, measured in a browser before this.
 *
 * The button promised « Importer 2 lignes » on a file the server then read as three, because the
 * screen carried the user's answer and none of its consequences. A count the primary repeats is a
 * figure, and it was wrong by exactly the line the user had just reclassified.
 */
describe('the count follows the answer', () => {
	it('adds the header line to the primary once it is declared data', async () => {
		await page.viewport(1280, 900);
		await open();

		const before = await page
			.getByRole('button', { name: m.import_columns_submit_many({ count: FILE.rowCount }) })
			.first()
			.element();
		expect(before).toBeTruthy();

		await clickToggle();

		await expect
			.element(
				page
					.getByRole('button', { name: m.import_columns_submit_many({ count: FILE.rowCount + 1 }) })
					.first()
			)
			.toBeInTheDocument();
	});

	it('says how many lines the file holds under that reading', async () => {
		await page.viewport(1280, 900);
		await open();
		await clickToggle();

		// The meta line and the primary are two renderings of ONE count, so they are asserted
		// together: a repair reaching only the button would leave the screen disagreeing with itself.
		const meta = document.body.textContent?.replace(/\s+/g, ' ') ?? '';
		expect(meta).toContain(`${FILE.rowCount + 1} lignes`);
	});
});

/**
 * #735, AT THE SEAM THE SCREEN READS: the Date row after the switch.
 *
 * A headerless file whose only date proof is on line 1 (`24/05/2025`). Under detection's guess the
 * Date column reads lines 2 and 3 only and is ambiguous; under the answer « données » it reads all
 * three and is proven day-first. The payload carries both fact sets, as `/import` sends them, and the
 * screen must read the one for the answer the user gave. Before the fix it read the raw prop: the
 * row stayed « ordre à confirmer » and stated line 2 as the first row.
 *
 * Separates « the screen reads the declared file » from « the screen reads the detected one »,
 * which `readWithHeaderRow`'s own spec cannot see because it never renders the row.
 */
describe('the Date row once line 1 is declared data (#735)', () => {
	const LINES = [
		['24/05/2025', 'Fleuriste Bellevue', '-31.00'],
		['06/01/2025', 'Pharmacie du Pont', '-18.90'],
		['03/02/2025', 'Primeur Sainte Anne', '-17.45']
	];
	const NONE = { dayFirst: [null, null, null, null], monthFirst: [null, null, null, null] };
	const HEADERLESS_FILE: DesignationFile = {
		name: 'releve.csv',
		headers: LINES[0],
		samples: [
			[LINES[1][0], LINES[2][0], ''],
			[LINES[1][1], LINES[2][1], ''],
			[LINES[1][2], LINES[2][2], '']
		],
		firstRow: LINES[1],
		dateStates: ['ambiguous', 'no-dates', 'no-dates'],
		dateReadings: [
			{
				dayFirst: ['2025-01-06', '2025-01-06', '2025-02-03', null],
				monthFirst: ['2025-06-01', '2025-06-01', '2025-03-02', null]
			},
			NONE,
			NONE
		],
		rowCount: 2,
		detectedHeaderRow: true,
		otherHeaderRowFacts: {
			samples: [
				[LINES[0][0], LINES[1][0], LINES[2][0]],
				[LINES[0][1], LINES[1][1], LINES[2][1]],
				[LINES[0][2], LINES[1][2], LINES[2][2]]
			],
			firstRow: LINES[0],
			previewRows: LINES,
			coverage: [3, 3, 3],
			dateStates: ['proven-day', 'no-dates', 'no-dates'],
			dateReadings: [
				{
					dayFirst: ['2025-05-24', '2025-05-24', '2025-01-06', '2025-02-03'],
					monthFirst: [null, null, '2025-06-01', '2025-03-02']
				},
				NONE,
				NONE
			]
		}
	};

	async function openAndDeclareData() {
		await page.viewport(390, 844);
		await render(ColumnDesignationScreen, {
			file: HEADERLESS_FILE,
			initialAssignment: ASSIGNMENT,
			candidates: {},
			accounts: [
				{
					id: 'account-1',
					name: 'BP · Compte courant',
					discriminant: '4417',
					transactionCount: 128
				}
			],
			initialAccountId: 'account-1'
		} as never);

		// Through the Libellé row: the Date row of an unanswered ambiguous column opens its QUESTION,
		// which carries no switch.
		await page
			.getByRole('button', { name: /^Libellé,/ })
			.first()
			.click();
		await page.getByRole('switch').first().click();
		await page.getByRole('button', { name: m.import_columns_picker_close() }).first().click();
		return page.getByRole('button', { name: /^Date,/ }).first();
	}

	// Formatted by the app's own formatter; the date it formats, line 1's `24/05/2025` read
	// day-first, is the claim under test.
	const LINE_1_PRETTY = () => formatReadingDate('2025-05-24', getLocale());
	// The catalogue's French typography puts narrow no-break spaces before « : », and both an
	// accessible name and a collapsed text content read them as plain spaces.
	const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

	// The row's NAME: the reading line 1 proves, and line 1's date. Separates the screen reading
	// the declared file's state and readings from reading the detected file's.
	it('names the reading line 1 proves, and line 1', async () => {
		expect.assertions(1);
		const row = await openAndDeclareData();

		await expect.element(row).toHaveAccessibleName(
			collapse(
				m.import_designate_date_row_aria_confirmed({
					header: m.import_columns_positional_name({ index: 1 }),
					order: m.import_datesheet_reading_in_sentence_day_first(),
					pretty: LINE_1_PRETTY()
				})
			)
		);
	});

	// The row's VISIBLE line 3, compared as a sentence: line 1's raw cell beside its own conversion.
	// Separates it from line 2's cell printed beside line 1's conversion, which the name above cannot
	// see because the name carries no raw cell.
	it('prints line 1 beside its own conversion', async () => {
		expect.assertions(2);
		const row = await openAndDeclareData();
		await expect.element(row).toBeInTheDocument();

		const line = row.element().querySelector('span.block');
		expect(collapse(line?.textContent ?? '')).toBe(
			collapse(m.import_designate_date_reading({ raw: '24/05/2025', pretty: LINE_1_PRETTY() }))
		);
	});
});
