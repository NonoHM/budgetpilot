import { page } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import * as m from '$lib/paraglide/messages';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import { EMPTY_ASSIGNMENT, type RoleAssignment } from '$lib/domain/columnDesignation';

/**
 * # THE DATE READING QUESTION, AWAKE. #639, and the successor to `dateReadingQuestionAsleep`.
 *
 * The step was built in #637 and deliberately unreachable: nothing set `step` to `'reading'`, and a
 * gate file held that interim rather than three docstrings describing it. This file is what
 * replaces it, and it asserts the four things the gate asserted the absence of.
 *
 * ## What the answer actually decides, which is why the figures here are dates and not flags
 *
 * `row.date` is the second field of `contentFieldsOf`, joined into the hash stored under
 * `@@unique([userId, dedupeKeyHash])`. So the reading is the identity of every row the file writes,
 * not the value of one column. Measured on all three engines before the field was threaded: the
 * same file under two readings produces two disjoint sets of hashes and nothing collides.
 *
 * ## The two entry points, and why there are two rather than one
 *
 * Designating an ambiguous column DEFERS the close by exactly one question (plate 7b). That covers
 * a column the user has just chosen. It does not cover a column detection already filled in, whose
 * row reads `01/02/2026 → 1 février 2026 · Confirmer`: an imperative that opens a list of columns
 * is a false affordance, so tapping that row opens the question it names. Step 1 stays one tap away
 * through step 2's own foot TapLink, which exists for exactly this.
 *
 * ## The answer is the ANSWER, never the applied reading
 *
 * `onSubmit` carries `null` until a human has chosen, and `decideDateOrder` consults an override
 * only where the column is ambiguous. Sending the applied reading instead would post `day-first`
 * for every proven column and every ISO file, which records a decision nobody took.
 */
const HEADERS = ['Date operation', 'Libelle', 'Montant'];

/** Column 0 ambiguous both ways: 03/04 is the first data row, 05/06 and 07/08 the samples. */
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

/** The same file with column 0 PROVING day-first. Nothing here is a question. */
const PROVEN = { ...FILE, dateStates: ['proven-day', 'no-dates', 'no-dates'] as const };

/**
 * A fourth column, `no-dates`, so the date role can MOVE without vacating another row. Three
 * columns cannot express that: every move lands on an occupied one and the vacated row is then the
 * thing under test rather than the reading.
 */
const FOUR_COLUMN = {
	...FILE,
	headers: [...HEADERS, 'Reference'],
	samples: [...FILE.samples, ['A1', 'B2', 'C3']],
	firstRow: [...FILE.firstRow, 'A1'],
	dateStates: ['ambiguous', 'no-dates', 'no-dates', 'no-dates'] as const,
	dateReadings: [
		...FILE.dateReadings,
		{ dayFirst: [null, null, null, null], monthFirst: [null, null, null, null] }
	]
};

const DATE_DESIGNATED: RoleAssignment = { date: 0, label: 1, amount: 2, category: null };

const ACCOUNTS = [
	{ id: 'account-1', name: 'BP · Compte courant', discriminant: '4417', transactionCount: 128 }
];

function mount(props: Record<string, unknown> = {}) {
	return render(ColumnDesignationScreen, {
		file: FILE,
		initialAssignment: EMPTY_ASSIGNMENT,
		accounts: ACCOUNTS,
		initialAccountId: 'account-1',
		announceDelayMs: 0,
		...props
	});
}

function cardOf(container: HTMLElement) {
	return container.querySelector('[data-testid="designation-card"]') as HTMLElement;
}

beforeEach(async () => {
	await page.viewport(390, 844);
});

describe('the date reading question can be answered', () => {
	/**
	 * THE INSTRUMENT IS ALIVE, in absolute figures, carried over from the gate this file replaces.
	 * Every presence assertion below is meaningless without it: a render that produced a partial
	 * screen fails here before anything else is reported.
	 */
	it('renders the screen it is asserting about', async () => {
		const { container } = mount({ initialAssignment: DATE_DESIGNATED });

		const card = cardOf(container);
		expect(card).not.toBeNull();
		expect(card.getBoundingClientRect().height).toBe(373);
		const rows = card.querySelectorAll('button[aria-haspopup="listbox"]');
		expect(rows.length).toBe(4);
		expect(rows[0].getBoundingClientRect().height).toBe(86);
	});

	/**
	 * PLATE 7b. Separates « designating an ambiguous column closes the sheet » from « it defers the
	 * close by exactly one question ». The column is APPLIED either way, which is the half that
	 * must not change: the row states the day-first reading behind the open question.
	 */
	it('defers the close by one question when the designated column is ambiguous', async () => {
		const { container } = mount();

		await page.getByRole('button', { name: /^Date, aucune colonne/ }).click();
		await page.getByRole('option', { name: /Date operation/ }).click();

		await expect.element(page.getByText(m.import_datesheet_title())).toBeVisible();
		expect(cardOf(container).textContent).toContain('3 avril 2026');
	});

	/**
	 * THE ONE THAT CARRIES THE BAR. Separates « the answer was recorded » from « the answer moved
	 * the dates the user is looking at ». `03/04/2026` read month-first is 4 March, and the absence
	 * of the day-first rendering is what makes this a change rather than an addition.
	 */
	it('moves the stated reading when the other reading is chosen', async () => {
		const { container } = mount();

		await page.getByRole('button', { name: /^Date, aucune colonne/ }).click();
		await page.getByRole('option', { name: /Date operation/ }).click();
		await page.getByRole('option', { name: /Mois puis jour/ }).click();

		const card = cardOf(container);
		expect(card.textContent).toContain('4 mars 2026');
		expect(card.textContent).not.toContain('3 avril 2026');
		expect(page.getByText(m.import_datesheet_title()).elements().length).toBe(0);
	});

	/**
	 * Separates « the answer reaches the submitted payload » from « the answer changed the screen
	 * and nothing else », which is the exact state #639 measured: the screen said 4 March and the
	 * import stored 2026-04-03.
	 */
	it('carries the chosen reading out through onSubmit', async () => {
		const onSubmit = vi.fn();
		mount({ onSubmit });

		await page.getByRole('button', { name: /^Date, aucune colonne/ }).click();
		await page.getByRole('option', { name: /Date operation/ }).click();
		await page.getByRole('option', { name: /Mois puis jour/ }).click();
		await page.getByRole('button', { name: /^Libell/ }).click();
		await page.getByRole('option', { name: /Libelle/ }).click();
		await page.getByRole('button', { name: /^Montant/ }).click();
		await page.getByRole('option', { name: /Montant/ }).click();
		await page.getByTestId('designation-primary').click();

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0]).toMatchObject({ dateOrder: 'month-first' });
	});

	/**
	 * THE DIRECTION THIS IS NOT GOING. `null` and `day-first` are not the same payload: the server's
	 * `decideDateOrder` settles an ambiguous column with the default when nobody answered, and
	 * posting `day-first` there would record a decision no human took. Separates « unanswered » from
	 * « answered day-first », which produce the identical dates and must not produce the identical
	 * stored reading.
	 */
	it('carries null when the question was never answered', async () => {
		const onSubmit = vi.fn();
		mount({ initialAssignment: DATE_DESIGNATED, onSubmit });

		await page.getByTestId('designation-primary').click();

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0]).toMatchObject({ dateOrder: null });
	});

	/**
	 * THE DIRECTION THIS IS NOT GOING, second half. A column that PROVES its order was never asked
	 * about, so designating it must close exactly as every other role does. Deferring here would put
	 * a question in front of a user whose file has already answered it, and `decideDateOrder`
	 * discards any answer given.
	 */
	it('closes immediately on a column that proves its own order', async () => {
		const { container } = render(ColumnDesignationScreen, {
			file: PROVEN,
			initialAssignment: EMPTY_ASSIGNMENT,
			accounts: ACCOUNTS,
			initialAccountId: 'account-1',
			announceDelayMs: 0
		});

		await page.getByRole('button', { name: /^Date, aucune colonne/ }).click();
		await page.getByRole('option', { name: /Date operation/ }).click();

		expect(page.getByText(m.import_datesheet_title()).elements().length).toBe(0);
		expect(cardOf(container).textContent).toContain('3 avril 2026');
	});

	/**
	 * THE SECOND ENTRY POINT. Separates « the question is reachable only by re-designating » from
	 * « the row's own imperative opens it ». The row reads `· Confirmer` in this state, and the
	 * planted positive is that imperative: a render whose row said nothing could not report this.
	 */
	it('opens the question from a row whose reading is still unconfirmed', async () => {
		const { container } = mount({ initialAssignment: DATE_DESIGNATED });

		expect(cardOf(container).textContent).toContain('Confirmer');
		await page.getByRole('button', { name: /^Date, colonne désignée/ }).click();

		await expect.element(page.getByText(m.import_datesheet_title())).toBeVisible();
	});

	/**
	 * Step 1 must stay reachable from step 2, or the second entry point above traps a user who
	 * wanted a different column. Separates « the foot TapLink re-asks step 1 » from « it closes the
	 * sheet », and the planted positive is the column list itself.
	 */
	it('re-asks the column question from the foot of the reading question', async () => {
		mount({ initialAssignment: DATE_DESIGNATED });

		await page.getByRole('button', { name: /^Date, colonne désignée/ }).click();
		await page.getByRole('button', { name: m.import_datesheet_change_column() }).click();

		await expect.element(page.getByRole('option', { name: /Libell/ })).toBeVisible();
		expect(page.getByRole('option').elements().length).toBe(3);
		expect(page.getByText(m.import_datesheet_title()).elements().length).toBe(0);
	});

	/**
	 * AN ANSWER IS ABOUT ONE COLUMN. Separates « the answer applies to the column it was given
	 * about » from « it is carried to whatever column the date role holds », which would state a
	 * reading on a row whose column has no dates in it at all and post it to the parse.
	 *
	 * The fourth column is `no-dates`, so the move vacates nothing and the row's line 3 changes
	 * KIND. The planted positive is that line: the row must state « Aucune date dans cette colonne »
	 * afterwards, so a render that produced no line cannot report the absence of the reading.
	 */
	it('states no reading for a column the answer was not about', async () => {
		const { container } = render(ColumnDesignationScreen, {
			file: FOUR_COLUMN,
			initialAssignment: DATE_DESIGNATED,
			initialDateOrder: 'month-first',
			accounts: ACCOUNTS,
			initialAccountId: 'account-1',
			announceDelayMs: 0
		});
		expect(cardOf(container).textContent).toContain('4 mars 2026');

		await page.getByRole('button', { name: /^Date, colonne désignée/ }).click();
		await page.getByRole('option', { name: /Reference/ }).click();

		const card = cardOf(container);
		expect(card.textContent).toContain(m.import_designate_date_reading_no_dates());
		expect(card.textContent).not.toContain('4 mars 2026');
		expect(card.textContent).not.toContain('3 avril 2026');
	});

	/**
	 * The same property through the SUBMITTED PAYLOAD, which is the half that decides stored data.
	 * Separates « the answer stopped being displayed » from « it stopped being posted »: the screen
	 * could perfectly well draw the new column's line and still send the old column's answer, and
	 * the parse would apply it to a column nobody was asked about.
	 */
	it('carries null once the designation moves off the column the answer was about', async () => {
		const onSubmit = vi.fn();
		render(ColumnDesignationScreen, {
			file: FOUR_COLUMN,
			initialAssignment: DATE_DESIGNATED,
			initialDateOrder: 'month-first',
			accounts: ACCOUNTS,
			initialAccountId: 'account-1',
			announceDelayMs: 0,
			onSubmit
		});

		await page.getByRole('button', { name: /^Date, colonne désignée/ }).click();
		await page.getByRole('option', { name: /Reference/ }).click();
		await page.getByTestId('designation-primary').click();

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0]).toMatchObject({ dateOrder: null });
	});

	/**
	 * AND THE DECISION IN THE OTHER DIRECTION, pinned rather than left to be rediscovered.
	 *
	 * Coming BACK to the column the answer was given about revives it, because the answer is about
	 * that column's own cells and those have not changed: the file is the same file. Re-asking there
	 * would be redundant entry for no new information. What must not revive is an answer applied to
	 * a DIFFERENT column, which is the test above.
	 *
	 * The planted positive is the imperative: it has to be absent, and the day-first rendering has
	 * to be absent with it, or « revived » and « reset to the default » would read the same.
	 */
	it('revives the answer when the designation comes back to its own column', async () => {
		const { container } = render(ColumnDesignationScreen, {
			file: FOUR_COLUMN,
			initialAssignment: DATE_DESIGNATED,
			initialDateOrder: 'month-first',
			accounts: ACCOUNTS,
			initialAccountId: 'account-1',
			announceDelayMs: 0
		});

		await page.getByRole('button', { name: /^Date, colonne désignée/ }).click();
		await page.getByRole('option', { name: /Reference/ }).click();
		await page.getByRole('button', { name: /^Date, colonne désignée/ }).click();
		await page.getByRole('option', { name: /Date operation/ }).click();

		const card = cardOf(container);
		expect(card.textContent).toContain('4 mars 2026');
		expect(card.textContent).not.toContain('3 avril 2026');
		expect(card.textContent).not.toContain('Confirmer');
	});

	/**
	 * THE COLLISION DECLINE LEG. `hasHeaderRow` is carried on BOTH legs of the duplicate-statement
	 * dialog, and the reading is the same kind of value: declining must reopen this screen already
	 * showing the answer, or the user answers a question they have answered. WCAG 2.2 **3.3.7
	 * Redundant Entry**.
	 *
	 * Separates « the seeded answer is applied and stated as confirmed » from « the prop is accepted
	 * and ignored », and only the absence of the day-first rendering can tell those apart.
	 */
	it('opens already answered when a prior answer is handed back to it', async () => {
		const { container } = mount({
			initialAssignment: DATE_DESIGNATED,
			initialDateOrder: 'month-first'
		});

		const card = cardOf(container);
		expect(card.textContent).toContain('4 mars 2026');
		expect(card.textContent).not.toContain('3 avril 2026');
		expect(card.textContent).not.toContain('Confirmer');
	});
	/**
	 * MOVED FROM `dateReadingQuestionAsleep.svelte.spec.ts`, which this file replaces. It is not
	 * about the gate and outlives it: THE TWO HALVES OF LINE 3 DESCRIBE ONE CELL, or the line states
	 * a conversion of something else.
	 *
	 * `firstRow` is OPTIONAL on `DesignationFile`, and the ISO half is always index 0 of
	 * `dateReadings`, which is the first data row's cell by that field's contract. While the raw half
	 * was read through `sampleOf`, a payload with readings and no first row paired `samples[col][0]`'s
	 * raw value with `firstRow`'s conversion: a line that reads perfectly and states a conversion the
	 * import never made. This is the test that caught it, and it is #641's structural half.
	 *
	 * Separates « the pair is true by construction » from « the pair happens to agree because both
	 * production payloads set firstRow ». The fixture deliberately omits `firstRow`, which is the one
	 * shape that can tell them apart. The planted positive is the row itself: its 86 px are asserted,
	 * so a render that produced no row cannot report this absence.
	 */
	it('says nothing on line 3 when the payload carries readings but no first row', async () => {
		const { firstRow: _omitted, ...withoutFirstRow } = FILE;
		const { container } = render(ColumnDesignationScreen, {
			file: withoutFirstRow,
			initialAssignment: DATE_DESIGNATED,
			accounts: ACCOUNTS,
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
	 * ALSO MOVED, and it is the one that carried the bar while the question was asleep: the row
	 * states a reading, and the reading it states must be the one the parser will actually use, or
	 * the screen displays a date the import will not write.
	 *
	 * `DEFAULT_DATE_ORDER` is day-first, so an UNANSWERED `03/04/2026` must read as 3 April and never
	 * as 4 March. Asserting the absence of the month-first rendering as well as the presence of the
	 * day-first one is what separates « the row agrees with the parser » from « the row printed
	 * something ». It is the display half of « carries null » above, and both are needed: the payload
	 * could be null while the row drew the other reading.
	 */
	it('states the default reading until a human has answered', async () => {
		const { container } = mount({ initialAssignment: DATE_DESIGNATED });

		const card = cardOf(container);
		expect(card.textContent).toContain('3 avril 2026');
		expect(card.textContent).not.toContain('4 mars 2026');
	});
});
