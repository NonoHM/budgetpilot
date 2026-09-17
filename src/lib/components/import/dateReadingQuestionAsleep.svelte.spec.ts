import { page } from 'vitest/browser';
import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import * as m from '$lib/paraglide/messages';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import { EMPTY_ASSIGNMENT, type RoleAssignment } from '$lib/domain/columnDesignation';

/**
 * THE SECOND STEP IS BUILT AND IS DELIBERATELY UNREACHABLE. This file is why, and it is a GATE
 * rather than a note: three docstrings saying the same thing would not fire.
 *
 * ## What was measured, and what it would cost to ship the step as it stands
 *
 * `/import/columns`'s action parses with `profile: 'mapped'` and passes NO `dateOrder`, so the
 * parser re-derives it and `decideDateOrder` settles an ambiguous column with the application
 * default. The user's answer is not in the submitted payload at all: `onSubmit` carries
 * `accountId`, `assignment`, `remember`, `hasHeaderRow` and `deleteOldImport`, and nothing else.
 *
 * Measured on `scr/synthetic/out/ambiguous-opaque-headers.csv`, 6 data rows, column 0 `ambiguous`,
 * both parses succeeding with 6 transactions:
 *
 * ```
 * as the action parses : 2026-02-01, 2026-02-03, 2026-02-05, 2026-02-06, 2026-02-09
 * told month-first     : 2026-01-02, 2026-03-02, 2026-05-02, 2026-06-02, 2026-09-02
 * ```
 *
 * So a user who chose « Mois puis jour » would read `4 mars 2026` on the row, press Importer, and
 * the import would store `2026-04-03`. Every date in the file wrong, the summary reporting success.
 * That is two of the standing bar's four triggers at once: a false displayed figure, and data
 * written wrong that looks right.
 *
 * It also reaches STORED DATA, which is why this is gated rather than fixed here. `row.date` is the
 * second field of `contentFieldsOf` in `dedupeRecompute.ts`, joined into the hash under
 * `@@unique([userId, dedupeKeyHash])`, so how a file's dates are read decides the identity of every
 * row it writes. Threading the answer changes what that key is computed over, and that is the
 * owner's call rather than a session's.
 *
 * ## What is built and left in place
 *
 * `ColumnPicker` renders step 2 in full and has its own spec. The screen computes
 * `dateReadingPairs` and HANDS IT to both picker mounts, so the payload is wired and correct. What
 * is missing is the one thing that would let a user answer: nothing ever sets `step` to
 * `'reading'`. The row's line 3 still states the reading, and that statement is TRUE, because the
 * order it names is the order the parser actually uses.
 *
 * Filed as #639. Deleting this file is a step of that issue, not a tidy-up.
 *
 * ## The zeros below are calibrated, and the calibration was RUN rather than reasoned
 *
 * An absence assertion over a screen that renders nothing at all passes for the wrong reason: a
 * gate asserting a zero that cannot itself fail is the thing a gate exists to prevent. So every
 * test here carries a planted positive taken from the SAME render, and the instrument was broken
 * two ways to prove the positives collapse first.
 *
 * | break | result |
 * | --- | --- |
 * | unbroken | 0 failed, 5 passed |
 * | the card stops rendering (`designation-card` testid renamed) | **4 failed**, 1 passed |
 * | the column options stop being options (`ColumnCard`'s `role="option"` to `presentation`) | **2 failed**, 3 passed |
 *
 * The two breaks are both needed and neither is redundant, which is the part worth keeping. The
 * card break leaves the column-list test green, because that test's positive is the picker's
 * option list rather than the card; the option break reddens it and leaves the card tests green.
 * **One break would have reported a calibrated gate over a test whose instrument it never
 * touched**, which is the same shape as a loop asserting one figure across four rows and never
 * saying which row it read.
 *
 * The figures were re-measured after the liveness test was added, which moved both rows by one.
 * A table in a docstring that nobody re-runs is this repository's recorded-figure failure, so the
 * numbers above are the ones the runs above printed and not the ones written first.
 *
 * Every failure above is on a POSITIVE, never on an absence. No run of a broken instrument ever
 * reported that the reading question was absent, which is the only claim this file makes.
 *
 * Following `dateOrderQuestionAsleep.spec.ts` (#617's successor), which is where this pattern
 * comes from: the liveness assertion below is its « reads a non-empty set » line, in the form a
 * component spec can take.
 */
const HEADERS = ['Date operation', 'Libelle', 'Montant'];

const FILE = {
	name: 'releve.csv',
	headers: HEADERS,
	samples: [
		['05/06/2026', '07/08/2026', '09/10/2026'],
		['CARREFOUR', 'SNCF', 'EDF'],
		['-12,90', '-45,00', '-83,10']
	],
	firstRow: ['03/04/2026', 'CARREFOUR', '-12,90'],
	rowCount: 132,
	detectedHeaderRow: true,
	dateStates: ['ambiguous', 'no-dates', 'no-dates'] as const,
	dateReadings: [
		{
			dayFirst: ['2026-04-03', '2026-06-05', '2026-08-07', '2026-10-09'],
			monthFirst: ['2026-03-04', '2026-05-06', '2026-07-08', '2026-09-10']
		},
		{ dayFirst: [null, null, null, null], monthFirst: [null, null, null, null] },
		{ dayFirst: [null, null, null, null], monthFirst: [null, null, null, null] }
	]
};

const DATE_DESIGNATED: RoleAssignment = { date: 0, label: 1, amount: 2, category: null };

function mount(props: Record<string, unknown> = {}) {
	return render(ColumnDesignationScreen, {
		file: FILE,
		initialAssignment: EMPTY_ASSIGNMENT,
		accounts: [
			{ id: 'account-1', name: 'BP · Compte courant', discriminant: '4417', transactionCount: 128 }
		],
		initialAccountId: 'account-1',
		announceDelayMs: 0,
		...props
	});
}

beforeEach(async () => {
	await page.viewport(390, 844);
});

describe('the date reading question cannot be answered yet', () => {
	/**
	 * THE INSTRUMENT IS ALIVE, asserted on its own rather than only inside the tests that depend on
	 * it. Separates « the screen rendered and has no reading question » from « nothing rendered ».
	 *
	 * Every zero below is meaningless without this line. It asserts the shape the other tests read
	 * from, in absolute figures rather than as a presence check: four role rows, the Date row at its
	 * 86, and a card at 373. A render that produced a partial screen fails here before any absence
	 * is reported.
	 */
	it('renders the screen it is asserting about', async () => {
		const { container } = mount({ initialAssignment: DATE_DESIGNATED });

		const card = container.querySelector('[data-testid="designation-card"]') as HTMLElement;
		expect(card).not.toBeNull();
		expect(card.getBoundingClientRect().height).toBe(373);
		const rows = card.querySelectorAll('button[aria-haspopup="listbox"]');
		expect(rows.length).toBe(4);
		expect(rows[0].getBoundingClientRect().height).toBe(86);
	});

	/**
	 * Separates « tapping the date row opens the column list » from « it opens the order question ».
	 * The planted positive is the column list itself: three options must be on screen, so a render
	 * that produced nothing cannot report this zero.
	 */
	it('opens the column list, never the reading question, on a designated ambiguous column', async () => {
		mount({ initialAssignment: DATE_DESIGNATED });

		await page.getByRole('button', { name: /^Date, colonne désignée/ }).click();

		await expect.element(page.getByRole('option', { name: /Libell/ })).toBeVisible();
		expect(page.getByRole('option').elements().length).toBe(3);
		expect(page.getByText(m.import_datesheet_title()).elements().length).toBe(0);
	});

	/**
	 * Separates « designating an ambiguous column closes the sheet » from « it defers the close by
	 * one question », which is what plate 7b rules and what this gate is holding back. The planted
	 * positive is the row's own line 3, which must state the reading afterwards.
	 */
	it('closes on choose rather than deferring to the reading question', async () => {
		const { container } = mount();

		await page.getByRole('button', { name: /^Date, aucune colonne/ }).click();
		await page.getByRole('option', { name: /Date operation/ }).click();

		const card = container.querySelector('[data-testid="designation-card"]') as HTMLElement;
		expect(card.textContent).toContain('3 avril 2026');
		expect(page.getByText(m.import_datesheet_title()).elements().length).toBe(0);
	});

	/**
	 * THE TWO HALVES OF LINE 3 DESCRIBE ONE CELL, or the line states a conversion of something else.
	 *
	 * `firstRow` is OPTIONAL on `DesignationFile`, and the ISO half is always index 0 of
	 * `dateReadings`, which is the first data row's cell by that field's contract. While the raw
	 * half was read through `sampleOf`, a payload with readings and no first row paired
	 * `samples[col][0]`'s raw value with `firstRow`'s conversion: a line that reads perfectly and
	 * states a conversion the import never made.
	 *
	 * Separates « the pair is true by construction » from « the pair happens to agree because both
	 * production payloads set firstRow ». The fixture here deliberately omits `firstRow`, which is
	 * the one shape that can tell them apart, and the row must reserve its line rather than invent a
	 * pairing. The planted positive is the row itself: its 86 px are asserted, so a render that
	 * produced no row cannot report this absence.
	 */
	it('says nothing on line 3 when the payload carries readings but no first row', async () => {
		const { firstRow: _omitted, ...withoutFirstRow } = FILE;
		const { container } = render(ColumnDesignationScreen, {
			file: withoutFirstRow,
			initialAssignment: DATE_DESIGNATED,
			accounts: [
				{
					id: 'account-1',
					name: 'BP · Compte courant',
					discriminant: '4417',
					transactionCount: 128
				}
			],
			initialAccountId: 'account-1',
			announceDelayMs: 0
		});

		const row = container.querySelector(
			'[data-testid="designation-card"] button[aria-haspopup="listbox"]'
		) as HTMLElement;
		expect(row.getBoundingClientRect().height).toBe(86);
		// `samples[0][0]` is 05/06/2026 and `dateReadings[0].dayFirst[0]` is 2026-04-03. Pairing them
		// would print « 05/06/2026 -> 3 avril 2026 », which is the exact lie this separates.
		expect(row.textContent).not.toContain('3 avril 2026');
		expect(row.textContent).not.toContain('5 juin 2026');
	});

	/**
	 * THE ONE THAT CARRIES THE BAR. The row states a reading, and the reading it states must be the
	 * one the parser will actually use, or the screen is displaying a date the import will not
	 * write.
	 *
	 * `DEFAULT_DATE_ORDER` is day-first, so `03/04/2026` must read as 3 April and never as 4 March.
	 * Asserting the absence of the month-first rendering as well as the presence of the day-first
	 * one is what makes this separate « the row agrees with the parser » from « the row printed
	 * something ».
	 */
	it('states the reading the parser will actually use, which is the application default', async () => {
		const { container } = mount({ initialAssignment: DATE_DESIGNATED });

		const card = container.querySelector('[data-testid="designation-card"]') as HTMLElement;
		expect(card.textContent).toContain('3 avril 2026');
		expect(card.textContent).not.toContain('4 mars 2026');
	});
});
