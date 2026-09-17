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
 * ## The zeros below are calibrated
 *
 * An absence assertion over a screen that renders nothing at all would pass for the wrong reason.
 * Each test therefore carries a planted positive: a figure that must be non-zero on the same
 * render, so a broken mount reddens before any absence can be reported.
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
