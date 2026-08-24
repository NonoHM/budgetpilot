import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import ColumnPicker from './ColumnPicker.svelte';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import * as m from '$lib/paraglide/messages';

/**
 * THE SIX ASSERTIONS THIS SCREEN'S ACCESSIBILITY SURVIVES BEING FORGOTTEN BY.
 *
 * ## Why this file holds two of the six and not all six
 *
 * The plan names one file carrying all six. It was written before Tasks 6 and 8 shipped, and four
 * of the six now hold in the specs of the components that own them:
 *
 * - 2, the panel announces as many options as accounts: `AccountPicker.svelte.spec.ts`
 * - 3, the row's name carries the account and no verb: `AccountRow.svelte.spec.ts`
 * - 4, the provenance is a description, absent from the name: same file
 * - 5, an option's name contains its second line: `AccountPicker.svelte.spec.ts`
 *
 * Copying them here would put one rule in two places, which is the thing this repository spends
 * the most comments arguing against, and the copies would drift the first time either was edited.
 * So this file carries the two that had NO home, and the break matrix for this task runs across all
 * six wherever they live, which is what the plan actually wanted: six assertions that redden.
 *
 * ## Assertion 1 found a real defect, which is why it is first
 *
 * The columns listbox carried its group headings as DIRECT CHILDREN of `role="listbox"`, beside the
 * `role="option"` cards. ARIA requires a listbox's children to be options, or groups containing
 * them; a `<p>` there is not in the listbox's content model, and an assistive technology walking
 * the list is entitled to skip it or to report the structure as broken. Nothing failed: the
 * headings render, the options render, every existing test passed. It was found by asking the
 * question this assertion asks.
 *
 * ## Filename
 *
 * `designationA11y.svelte.spec.ts` rather than the plan's `accountRowA11y.spec.ts`. The `.svelte.` infix is not decoration: it is what the browser project's glob matches, and without it the file runs in the node pool and dies at import on `vitest/browser`: assertion 1 is about the COLUMNS
 * listbox, which is not the account row, and a file named for one of its two subjects sends the
 * next reader to the wrong component.
 */

const HEADERS = ['Date', 'Libellé', 'Montant', 'Catégorie'];

/** The screen takes the UNRESOLVED file, with the guess rather than the answer. */
const SCREEN_FILE = {
	name: 'releve.csv',
	headers: HEADERS,
	samples: HEADERS.map((_, index) => [`v${index}a`, `v${index}b`]),
	rowCount: 12,
	detectedHeaderRow: true
};

const FILE = {
	name: 'releve.csv',
	headers: HEADERS,
	samples: HEADERS.map((_, index) => [`v${index}a`, `v${index}b`, `v${index}c`]),
	firstRow: ['01/06/2026', 'CARREFOUR', '-42,10', 'Courses'],
	rowCount: 12,
	hasHeaderRow: true
} as unknown as Parameters<typeof ColumnPicker>[1]['file'];

/**
 * A fixture that reaches ALL THREE groups, which is what makes assertion 1 answerable: the
 * designated column, a proposed one and the rest each contribute a heading, and a fixture with one
 * group would report on a listbox that has one heading in it rather than three.
 */
function mountColumns() {
	return render(ColumnPicker, {
		open: true,
		role: 'date',
		file: FILE,
		assignment: { date: 0, label: null, amount: null, category: null },
		candidates: [2],
		onChoose: () => {},
		onClose: () => {}
	});
}

describe('1. the columns listbox contains options, and nothing that is not one', () => {
	it('has no child that is neither an option nor a group of options', () => {
		// SEPARATES: « every child of `role="listbox"` is in its content model » FROM « the group
		// headings sit inside it as bare paragraphs ». Both render identically. Only the second
		// hands an assistive technology a list whose children it is entitled to skip, and the
		// visible page is the same either way, which is why nothing caught it for two tasks.
		//
		// The headings are NOT moved out of the listbox: they scroll with the options and a heading
		// that stayed put while its group scrolled away would label the wrong rows. They become
		// `role="group"` with the heading as the group's own label, which is the shape ARIA has for
		// exactly this, and the options nest inside.
		expect.assertions(3);
		mountColumns();
		const listbox = document.querySelector('[data-testid="column-listbox"]');
		expect(listbox).not.toBeNull();
		const children = [...listbox!.children];
		// The absolute figure beside the claim: the listbox has children at all. An empty listbox
		// satisfies « no child is out of the content model » and says nothing.
		expect(children.length).toBeGreaterThan(0);
		// `aria-hidden` children are excluded, and that is the rule rather than a loophole: an element
		// removed from the accessibility tree is not an owned element of the listbox at all, so the
		// content model has nothing to say about it. The spacer under the last card is the only one,
		// and it is `role="presentation"` besides. The loophole it could become — marking every card
		// hidden — is closed by the next test, which counts the options that remain.
		expect(
			children
				.filter((child) => child.getAttribute('aria-hidden') !== 'true')
				.filter((child) => !['option', 'group'].includes(child.getAttribute('role') ?? ''))
				.map((child) => `${child.tagName.toLowerCase()}[role=${child.getAttribute('role')}]`)
		).toStrictEqual([]);
	});

	it('keeps every option reachable, inside a group or directly', () => {
		// SEPARATES: « the options are still there after the regrouping » FROM « the fix hid them ».
		// A listbox whose children are all groups and whose groups are empty passes the assertion
		// above perfectly, which is why this one exists beside it.
		expect.assertions(2);
		mountColumns();
		const options = page.getByRole('option').elements();
		// Four headers, four options, whatever grouping they are arranged into.
		expect(options).toHaveLength(HEADERS.length);
		expect(options.every((option) => option.closest('[data-testid="column-listbox"]'))).toBe(true);
	});

	it('gives each group a name, so a heading that stops being a paragraph does not stop being read', () => {
		// SEPARATES: « the regrouping KEPT the heading text in the accessibility tree » FROM « it
		// removed the paragraphs and put nothing in their place ». The fix must not be an
		// improvement on paper that loses the label the sighted user reads.
		expect.assertions(2);
		mountColumns();
		const groups = [...document.querySelectorAll('[data-testid="column-listbox"] [role="group"]')];
		expect(groups.length).toBeGreaterThan(0);
		expect(
			groups.every((group) => (group.getAttribute('aria-label') ?? '').trim().length > 0)
		).toBe(true);
	});
});

/**
 * ASSERTION 6, and only its FOCUS half.
 *
 * The other half, « the error is in the accessible name and `aria-invalid` is not carried », holds
 * in `AccountRow.svelte.spec.ts`, where the row is mounted alone with `state: 'error'`. That says
 * nothing about whether the SCREEN puts it into that state and moves focus there, which is a
 * different question with a different owner, and the one nothing was asking.
 *
 * The user's ruling of 2026-08-23 stands here as it does there: `aria-invalid` is dropped, and the
 * error travels in the accessible name instead. ARIA 1.2 does not list `aria-invalid` as supported
 * on `role=button`, so carrying it is an attribute a screen reader may ignore — a control that
 * reads as present and does nothing.
 */
describe('6. pressing the primary with no account moves focus to the row that is missing', () => {
	it('focuses the account row, not the alert, and names the error in the row itself', async () => {
		// SEPARATES: « focus lands on the control the user must now operate » FROM « focus lands on
		// the message about it, or stays where it was ». The second leaves a keyboard user reading a
		// sentence with no way to act on it without hunting, and it is the more natural thing to
		// build: the banner is what just appeared.
		expect.assertions(4);
		render(ColumnDesignationScreen, {
			file: SCREEN_FILE,
			initialAssignment: { date: 0, label: 1, amount: 2, category: null },
			accounts: [],
			initialAccountId: null,
			announceDelayMs: 0
		});

		// Clicked on the ELEMENT rather than through the locator's own click, and the comment is the
		// rule: the primary carries `aria-disabled="true"` in this state, and both Playwright and
		// vitest-browser treat that as not enabled and wait forever for it to become so. It is a
		// live control that refuses and says why, which is the whole design of this state.
		const primary = page.getByRole('button', { name: m.import_columns_submit_blocked() });
		await expect.element(primary).toBeInTheDocument();
		(primary.element() as HTMLElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		const row = page.getByRole('button', { name: new RegExp(m.import_account_row_label()) });
		await expect.element(row).toBeInTheDocument();
		expect(document.activeElement).toBe(row.element());
		// The error is IN the row's own name, which no verbosity setting can switch off, and
		// `aria-invalid` is not carried. Both halves of the ruling, asserted where the screen
		// produced the state rather than where the component was handed it.
		expect(row.element().getAttribute('aria-label')).toContain(m.import_account_error_required());
	});

	it('carries no aria-invalid on the row it just put into error', () => {
		// SEPARATES: « the ruling held through the screen » FROM « the component drops the attribute
		// and the screen adds it back ». One line, and it is the line a later contributor restores
		// « for completeness » on the argument that 6h specifies it.
		expect.assertions(1);
		const { container } = render(ColumnDesignationScreen, {
			file: SCREEN_FILE,
			initialAssignment: { date: 0, label: 1, amount: 2, category: null },
			accounts: [],
			initialAccountId: null,
			announceDelayMs: 0
		});
		expect(container.querySelectorAll('[aria-invalid]')).toHaveLength(0);
	});
});
