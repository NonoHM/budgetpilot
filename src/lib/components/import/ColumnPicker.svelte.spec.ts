import { page, userEvent } from 'vitest/browser';
import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import * as m from '$lib/paraglide/messages';
import ColumnPicker from './ColumnPicker.svelte';
import { EMPTY_ASSIGNMENT, type RoleAssignment } from '$lib/domain/columnDesignation';

/**
 * Plate 7: the `step` prop, its second body, and the rules around switching between them.
 *
 * Only the NEW surface is exercised here. Step 1's own content (groups, markers, search) has its
 * own coverage already implied by `ColumnDesignationScreen`'s specs and is not repeated: what this
 * file adds is the thing that did not exist before, `step`, and everything that moves with it.
 *
 * Viewport pinned to 390x844 for the sheet tests (the sheet is `lg:hidden`) and to 1280x900 for the
 * anchored ones, per `ColumnDesignationScreen.desktop.svelte.spec.ts`'s own convention.
 */

const HEADERS = ['Date operation', 'Libelle', 'Montant'];

const FILE = {
	name: 'releve.csv',
	headers: HEADERS,
	samples: [
		['03/04/2026', '11/04/2026', '02/04/2026'],
		['v1a', 'v1b', 'v1c'],
		['v2a', 'v2b', 'v2c']
	],
	rowCount: 40,
	hasHeaderRow: true,
	detectedHeaderRow: true
};

const ASSIGNMENT: RoleAssignment = { ...EMPTY_ASSIGNMENT, date: 0 };

const DATE_READING = {
	dayFirstPretty: ['3 avril 2026', '11 avril 2026', '2 avril 2026'],
	monthFirstPretty: ['4 mars 2026', '4 novembre 2026', '4 février 2026'],
	retained: 'day-first' as const
};

async function mountSheet(props: Record<string, unknown> = {}) {
	return await render(ColumnPicker, {
		open: true,
		role: 'date',
		file: FILE,
		assignment: ASSIGNMENT,
		...props
	});
}

beforeEach(async () => {
	await page.viewport(390, 844);
});

describe('step defaults to columns, so every existing call site is unaffected', () => {
	it('separates a caller that never passes step from one that explicitly asks for columns', async () => {
		await mountSheet();
		await expect
			.element(page.getByRole('heading', { name: m.import_columns_picker_title_date() }))
			.toBeVisible();
		expect(page.getByRole('listbox', { name: m.import_datesheet_title() }).elements()).toHaveLength(
			0
		);
	});
});

describe('step "reading" renders the second body instead of the first, in the same sheet', () => {
	it('separates the reading body from the columns body: only one is ever on screen', async () => {
		await mountSheet({ step: 'reading', dateReading: DATE_READING });

		await expect
			.element(page.getByRole('heading', { name: m.import_datesheet_title() }))
			.toBeVisible();
		// The columns listbox and its search/switch row are gone, not merely hidden: the columns
		// title used at step 1 must not still be on the page under a different role.
		expect(page.getByText(m.import_columns_first_row_label()).elements()).toHaveLength(0);
	});

	it('separates a readable header from an unreadable one in the subline', async () => {
		await mountSheet({ step: 'reading', dateReading: DATE_READING });
		await expect
			.element(page.getByText(m.import_datesheet_subline({ header: 'Date operation' })))
			.toBeVisible();
	});

	it('separates a headerless file from a headered one: the subline falls back to a position', async () => {
		await mountSheet({
			step: 'reading',
			dateReading: DATE_READING,
			file: { ...FILE, hasHeaderRow: false }
		});
		await expect
			.element(page.getByText(m.import_datesheet_subline_no_header({ count: 1 })))
			.toBeVisible();
	});

	it('separates a missing dateReading payload from a present one: the sheet falls back to columns rather than rendering an empty question', async () => {
		await mountSheet({ step: 'reading' });
		await expect
			.element(page.getByRole('heading', { name: m.import_columns_picker_title_date() }))
			.toBeVisible();
	});

	it('renders exactly two options in a single-select listbox, day-first before month-first', async () => {
		await mountSheet({ step: 'reading', dateReading: DATE_READING });
		const listbox = page.getByRole('listbox', { name: m.import_datesheet_title() });
		await expect.element(listbox).toBeVisible();
		const options = page.getByRole('option');
		await expect.element(options.nth(0)).toBeVisible();
		expect(options.elements()).toHaveLength(2);
		expect(options.nth(0).element().textContent).toContain('3 avril 2026');
		expect(options.nth(1).element().textContent).toContain('4 mars 2026');
	});

	it('marks the retained reading as selected, and only that one', async () => {
		await mountSheet({ step: 'reading', dateReading: DATE_READING });
		const options = page.getByRole('option');
		expect(options.nth(0).element().getAttribute('aria-selected')).toBe('true');
		expect(options.nth(1).element().getAttribute('aria-selected')).toBe('false');
	});
});

/**
 * #669. `importSampleValues` pads a column holding fewer than three values with `''`, and the
 * reading step used to build its pairs from the padded array, so a two-row file announced
 * « Jour puis mois. Trois exemples : 1 juin 2026, 2 juin 2026, . » and drew a third line holding
 * a bare arrow.
 *
 * The SENTENCE is compared, never a fragment: every `toContain` still finds « 1 juin 2026 » in the
 * malformed name, which is how the defect sat under a green suite.
 */
describe('#669: a column with fewer than three values shows the values it has, and no padding', () => {
	const TWO_ROW_FILE = {
		...FILE,
		samples: [['01/06/2026', '02/06/2026', ''], FILE.samples[1], FILE.samples[2]],
		rowCount: 2
	};
	const TWO_ROW_READING = {
		dayFirstPretty: ['1 juin 2026', '2 juin 2026', ''],
		monthFirstPretty: ['6 janvier 2026', '6 février 2026', ''],
		retained: 'day-first' as const
	};

	it('separates two real examples from two plus a padded one: each name lists exactly the two', async () => {
		await mountSheet({ step: 'reading', dateReading: TWO_ROW_READING, file: TWO_ROW_FILE });
		const options = page.getByRole('option');
		await expect.element(options.nth(0)).toBeVisible();

		expect(options.nth(0).element().getAttribute('aria-label')).toBe(
			'Jour puis mois. Exemples : 1 juin 2026, 2 juin 2026.'
		);
		expect(options.nth(1).element().getAttribute('aria-label')).toBe(
			'Mois puis jour. Exemples : 6 janvier 2026, 6 février 2026.'
		);
	});

	it('separates a drawn pair from a padded one: the card prints two readings and no bare arrow', async () => {
		await mountSheet({ step: 'reading', dateReading: TWO_ROW_READING, file: TWO_ROW_FILE });
		const options = page.getByRole('option');
		await expect.element(options.nth(0)).toBeVisible();

		// Every line box the card draws, with the reserved (empty) ones dropped: the card keeps its
		// 107 px by reserving a third line, and a reserved line is air, not a pair. A padded pair is
		// NOT dropped by this filter, because it draws its arrow.
		const drawn = [
			...options.nth(0).element().querySelectorAll('[data-testid="date-reading-card-lines"] > span')
		]
			.map((line) => (line.textContent ?? '').replace(/\s+/g, ' ').trim())
			.filter((text) => text !== '');
		expect(drawn).toEqual(['01/06/2026 → 1 juin 2026', '02/06/2026 → 2 juin 2026']);
	});

	it('separates a count the subline claims from the count it shows: no « 3 » above two values', async () => {
		await mountSheet({ step: 'reading', dateReading: TWO_ROW_READING, file: TWO_ROW_FILE });
		await expect
			.element(page.getByText(m.import_datesheet_subline({ header: 'Date operation' })))
			.toBeVisible();
		expect(m.import_datesheet_subline({ header: 'Date operation' })).toBe(
			'«\u202FDate operation\u202F» · premières valeurs'
		);
	});
});

describe('the foot TapLink is a re-ask, not a back', () => {
	it('separates "change column" from "close": it calls onChangeColumn and not onClose', async () => {
		let changeColumnCalls = 0;
		let closeCalls = 0;
		await mountSheet({
			step: 'reading',
			dateReading: DATE_READING,
			onChangeColumn: () => changeColumnCalls++,
			onClose: () => closeCalls++
		});
		await userEvent.click(page.getByText(m.import_datesheet_change_column()));
		expect(changeColumnCalls).toBe(1);
		expect(closeCalls).toBe(0);
	});
});

describe('keyboard: arrows move focus and selection follows it', () => {
	it('separates ArrowDown from a click: pressing it while day-first is active chooses month-first', async () => {
		const chosen: string[] = [];
		await mountSheet({
			step: 'reading',
			dateReading: DATE_READING,
			onChooseReading: (order: string) => chosen.push(order)
		});
		const listbox = page.getByRole('listbox', { name: m.import_datesheet_title() });
		(await listbox.element()).focus();
		await userEvent.keyboard('{ArrowDown}');
		expect(chosen).toEqual(['month-first']);
	});

	it('separates a clamped edge from a wrap: ArrowUp while day-first (the first option) is already active chooses nothing', async () => {
		const chosen: string[] = [];
		await mountSheet({
			step: 'reading',
			dateReading: DATE_READING,
			onChooseReading: (order: string) => chosen.push(order)
		});
		const listbox = page.getByRole('listbox', { name: m.import_datesheet_title() });
		(await listbox.element()).focus();
		await userEvent.keyboard('{ArrowUp}');
		expect(chosen).toEqual([]);
	});

	it('separates Enter-to-confirm from Enter-doing-nothing: pressing it on the already-active option still reports a choice', async () => {
		const chosen: string[] = [];
		await mountSheet({
			step: 'reading',
			dateReading: DATE_READING,
			onChooseReading: (order: string) => chosen.push(order)
		});
		const listbox = page.getByRole('listbox', { name: m.import_datesheet_title() });
		(await listbox.element()).focus();
		await userEvent.keyboard('{Enter}');
		expect(chosen).toEqual(['day-first']);
	});

	it('separates aria-activedescendant pointing at a real option from one pointing at nothing', async () => {
		await mountSheet({ step: 'reading', dateReading: DATE_READING });
		const listbox = await page.getByRole('listbox', { name: m.import_datesheet_title() }).element();
		const activeId = listbox.getAttribute('aria-activedescendant');
		expect(activeId).toBeTruthy();
		const target = document.getElementById(activeId ?? '');
		expect(target?.getAttribute('role')).toBe('option');
		expect(target?.getAttribute('aria-selected')).toBe('true');
	});
});

describe('focus at the step change goes to the new title, never to a live region', () => {
	it('separates a step change from an open: the heading is an h2 with tabindex -1 that receives focus when step flips while already open', async () => {
		const { rerender } = await mountSheet({ step: 'columns' });
		await expect
			.element(page.getByRole('heading', { name: m.import_columns_picker_title_date() }))
			.toBeVisible();

		await rerender({ step: 'reading', dateReading: DATE_READING });

		const heading = await page.getByRole('heading', { name: m.import_datesheet_title() }).element();
		expect(heading.tagName).toBe('H2');
		expect(heading.getAttribute('tabindex')).toBe('-1');
		expect(document.activeElement).toBe(heading);
	});
});

describe('committed: true once the open-to-close session has applied anything, across both steps', () => {
	it('separates a session that only opened from one that designated a column: closing without touching anything reports false', async () => {
		let received: boolean | undefined;
		await mountSheet({ onClose: (committed: boolean) => (received = committed) });
		await userEvent.keyboard('{Escape}');
		expect(received).toBe(false);
	});

	it('separates a reading chosen earlier in the session from one never touched: closing after choosing a reading, then reopening on a fresh session, reports false again', async () => {
		let received: boolean | undefined;
		const { rerender } = await mountSheet({
			step: 'reading',
			dateReading: DATE_READING,
			open: false,
			onClose: (committed: boolean) => (received = committed)
		});
		// A fresh open, never touched, must start uncommitted even though a PRIOR session (in a
		// different mount) chose a reading — this mount's `committed` cannot borrow another session's.
		await rerender({ open: true, step: 'reading', dateReading: DATE_READING });
		await userEvent.keyboard('{Escape}');
		expect(received).toBe(false);
	});

	it('separates choosing a reading from merely opening: closing after an ArrowDown selection reports true', async () => {
		let received: boolean | undefined;
		await mountSheet({
			step: 'reading',
			dateReading: DATE_READING,
			onClose: (committed: boolean) => (received = committed)
		});
		const listbox = page.getByRole('listbox', { name: m.import_datesheet_title() });
		(await listbox.element()).focus();
		await userEvent.keyboard('{ArrowDown}');
		await userEvent.keyboard('{Escape}');
		expect(received).toBe(true);
	});

	it('separates designating a new column from re-choosing the one already designated: only the former commits', async () => {
		let received: boolean | undefined;
		await mountSheet({
			candidates: [1],
			onClose: (committed: boolean) => (received = committed)
		});
		// Re-choosing the ALREADY designated column (index 0) is documented as a no-op at step 1
		// (§5.3): it must not flip `committed`.
		await userEvent.click(page.getByRole('option').first());
		await userEvent.keyboard('{Escape}');
		expect(received).toBe(false);
	});
});

/**
 * The coordinator's correction: `step` must work in the ANCHORED panel too, not only the sheet.
 * `ColumnPicker`'s own docstring calls both variants "the SAME listbox... rendered from one
 * snippet", so the risk this section exists to catch is that `readingBody` only got wired into
 * one of the two `{@render}` call sites.
 */
describe('the anchored variant (1280) renders the same two bodies as the sheet', () => {
	beforeEach(async () => {
		await page.viewport(1280, 900);
	});

	it('separates the anchored dialog from the sheet: step "reading" renders there too', async () => {
		await render(ColumnPicker, {
			open: true,
			variant: 'anchored',
			role: 'date',
			file: FILE,
			assignment: ASSIGNMENT,
			step: 'reading',
			dateReading: DATE_READING,
			// A caller with columns to go back to, unlike the auto path's reading-only offer, whose
			// own test below asserts the opposite: absence hides the link entirely.
			onChangeColumn: () => {}
		});

		await expect
			.element(page.getByRole('dialog', { name: m.import_datesheet_title() }))
			.toBeVisible();
		const options = page.getByRole('option');
		expect(options.elements()).toHaveLength(2);
		await expect.element(page.getByText(m.import_datesheet_change_column())).toBeVisible();
	});

	/**
	 * THE AUTO PATH'S OWN REQUIREMENT, plate 7l: "no column list, no back to it." A caller with no
	 * columns to go back to (the auto path's reading-only offer, `+page.svelte`) omits
	 * `onChangeColumn` rather than passing a no-op, and the link must not merely do nothing when
	 * pressed — it must not be ON SCREEN, because a visible link with no destination is a false
	 * affordance the plate explicitly forbids.
	 *
	 * FOUND BY A BROWSER WALK, not by a test: every existing test either passed the callback or
	 * never asserted the link's presence, so the unconditional render survived the whole suite.
	 */
	it('hides the change-column link entirely when the caller has none to offer', async () => {
		await render(ColumnPicker, {
			open: true,
			variant: 'anchored',
			role: 'date',
			file: FILE,
			assignment: ASSIGNMENT,
			step: 'reading',
			dateReading: DATE_READING
		});

		await expect
			.element(page.getByRole('dialog', { name: m.import_datesheet_title() }))
			.toBeVisible();
		expect(page.getByText(m.import_datesheet_change_column()).elements()).toHaveLength(0);
	});

	it('separates a step change from an open in the anchored panel too: the h2 receives focus', async () => {
		const { rerender } = await render(ColumnPicker, {
			open: true,
			variant: 'anchored',
			role: 'date',
			file: FILE,
			assignment: ASSIGNMENT,
			step: 'columns'
		});
		await expect
			.element(page.getByRole('heading', { name: m.import_columns_picker_title_date() }))
			.toBeVisible();

		await rerender({
			open: true,
			variant: 'anchored',
			role: 'date',
			file: FILE,
			assignment: ASSIGNMENT,
			step: 'reading',
			dateReading: DATE_READING
		});

		const heading = await page.getByRole('heading', { name: m.import_datesheet_title() }).element();
		expect(heading.tagName).toBe('H2');
		expect(document.activeElement).toBe(heading);
	});
});
