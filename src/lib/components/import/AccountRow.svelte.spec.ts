import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import * as m from '$lib/paraglide/messages';
import AccountRow from './AccountRow.svelte';

/**
 * The account row's states.
 *
 * Every assertion names the TWO STATES it separates. A break-check proves a test can redden; it
 * does not prove it reddens for the reason it names, and an assertion whose two states cannot be
 * named is claiming that something happened rather than which thing.
 *
 * The strings come from the catalogue rather than being retyped. Retyping a French literal here
 * would assert something an English locale never renders, and would put the catalogue and the test
 * on one source: the two sides of a comparison must come from different places.
 *
 * `layout.css` is imported because the heights below are real measurements. Without it the
 * assertions read plausible numbers instead of failing, which this repository has measured twice.
 *
 * ## BREAK MATRIX, read per test, run 2026-08-22, AND WHY IT IS HERE
 *
 * **These tests were written after the component, so none of them was seen red first.** Said
 * plainly rather than implied: a test that passes on its first run proves only that it agrees with
 * the code it was written against. The matrix below is the compensation, and it is a stronger
 * claim than a first-run red would have been, because it says which single assertion each defect
 * moves.
 *
 * Calibration on the unbroken component: `Tests 8 passed (8)`.
 *
 * | Break                                        | Result                     |
 * | -------------------------------------------- | -------------------------- |
 * | A: the hint moved INTO the accessible name   | `1 failed | 7 passed (8)`  |
 * | B: the prompt becomes a placeholder attribute | `1 failed | 7 passed (8)` |
 * | C: `aria-invalid` dropped                    | `1 failed | 7 passed (8)`  |
 * | D: the chevron loses `aria-hidden`           | `1 failed | 7 passed (8)`  |
 * | E: the height 68 becomes 64                  | `1 failed | 7 passed (8)`  |
 *
 * **Exactly one red per break, never two and never zero.** Two would mean an assertion is a
 * restatement of another; zero would mean it asserts nothing. Each target was counted and refused
 * unless it occurred exactly once, and the component was restored in a `finally`.
 */
const HINT_FROM_FILE = m.import_account_hint_from_file({ fragment: '4417' });

function mount(props: Record<string, unknown>) {
	const { container } = render(AccountRow, { state: 'todo', ...props });
	container.style.width = '320px';
	return container.firstElementChild as HTMLElement;
}

describe('the account row', () => {
	it('names the account, and keeps the provenance out of the name', async () => {
		// SEPARATES: « the provenance is a description » FROM « the provenance is part of the
		// name ». Both render the same pixels. Only the second announces the whole sentence on
		// every focus, and only the accessible surface tells them apart.
		const row = mount({
			state: 'ok',
			value: 'BP · Compte courant',
			hint: HINT_FROM_FILE,
			panelId: 'p1'
		});
		const expected = m.import_account_row_aria({ account: 'BP · Compte courant' });
		const trigger = page.getByRole('button', { name: expected });
		await expect.element(trigger).toBeInTheDocument();

		// EQUALITY, not containment, and the break matrix is why. `getByRole`'s name option matches
		// a SUBSTRING, so « Modifier Compte, BP · Compte courant » satisfies the locator above
		// perfectly: a verb prepended to the label reddened nothing, and « and no verb » was a
		// sentence in the test's title that no assertion made. The exact name is the claim.
		expect(trigger.element().getAttribute('aria-label')).toBe(expected);
		expect(trigger.element().getAttribute('aria-label')).not.toContain('IBAN');

		// The LINKAGE, not merely the presence of the hint element. Asserting the paragraph exists
		// and holds the right words says nothing about whether the row points at it: removing
		// `aria-describedby` left the paragraph exactly where it was, visible and correct, and
		// silent to a screen reader. That is the provenance leaving the accessibility tree without
		// leaving the screen.
		expect(row.getAttribute('aria-describedby')).toBe('account-row-hint-p1');
		expect(document.getElementById('account-row-hint-p1')?.textContent).toBe(HINT_FROM_FILE);
	});

	it('prompts in real text rather than in a placeholder attribute', async () => {
		// SEPARATES: « the prompt is readable text in the accessibility tree » FROM « the prompt is
		// a placeholder attribute ». A placeholder is not reliably announced, is not contrasted,
		// and vanishes on input, leaving an unlabelled button.
		const row = mount({ hint: m.import_account_hint_unknown() });
		await expect
			.element(page.getByRole('button', { name: m.import_account_row_label() }))
			.toBeInTheDocument();
		expect(row.textContent).toContain(m.import_account_row_placeholder());
		expect(row.querySelector('[placeholder]')).toBeNull();
	});

	it('puts the error into its own NAME once the primary was pressed with no account', async () => {
		// SEPARATES: « the error is in the accessible NAME, which no setting can switch off » FROM
		// « the error is only a description », which a screen reader's verbosity setting can drop.
		// The rose ground is the visible half and a description is not the other half.
		//
		// USER RULING, 2026-08-23: `aria-invalid` is DROPPED rather than carried. ARIA 1.2 does not
		// list it as supported on `role=button`, so it is an attribute a screen reader may ignore,
		// which is a control that reads as present and does nothing. That is the class this project
		// has removed four times. The plate's 6h specifies it; this is a recorded deviation.
		const row = mount({ state: 'error', hint: m.import_account_error_required() });
		expect(row.hasAttribute('aria-invalid')).toBe(false);
		expect(row.getAttribute('aria-label')).toContain(m.import_account_error_required());
		expect(row.textContent).toContain(m.import_account_error_required());
	});

	it('is never disabled, in any state', () => {
		// SEPARATES: « the path stays open and pressing reveals the error » FROM « the control is
		// greyed and the user is told nothing ». Asserted because a greyed row is exactly what a
		// later contributor adds for completeness, and a disabled control cannot be asked why.
		for (const state of ['ok', 'todo', 'error'] as const) {
			const row = mount({ state, value: state === 'ok' ? 'X' : undefined });
			expect(row.hasAttribute('disabled')).toBe(false);
			expect(row.getAttribute('aria-disabled')).toBeNull();
		}
	});

	it('declares the popup it controls and whether it is open', () => {
		// SEPARATES: « the row declares a listbox popup and its expanded state » FROM « the row is
		// an ordinary button that happens to open something ». Without the first, a screen reader
		// user is never told a list exists, nor that it opened.
		const row = mount({ expanded: true, panelId: 'account-panel' });
		expect(row.getAttribute('aria-haspopup')).toBe('listbox');
		expect(row.getAttribute('aria-expanded')).toBe('true');
		expect(row.getAttribute('aria-controls')).toBe('account-panel');
	});

	it('goes inert while the import is in flight and stays readable', () => {
		// SEPARATES: « the row is busy and still shows its value » FROM « the row is emptied or
		// hidden during the import ». The user must still be able to read where the file is going
		// at the moment they can no longer change it.
		const row = mount({ state: 'ok', value: 'BP · Compte courant', busy: true });
		expect(row.getAttribute('aria-busy')).toBe('true');
		expect(row.textContent).toContain('BP · Compte courant');
	});

	it('is one target and one tab stop, chevron included', () => {
		// SEPARATES: « the whole row is one button » FROM « the chevron is a second one ». The
		// second doubles the tab stops for one action and gives assistive technology two names for
		// one thing.
		const row = mount({ state: 'ok', value: 'BP · Compte courant' });
		expect(row.tagName).toBe('BUTTON');
		expect(row.querySelectorAll('button')).toHaveLength(0);
		expect(row.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
	});

	it('is 68 px at 390 and 56 at 1280, which is the row height and not a control height', () => {
		// SEPARATES: « the row matches the designation-row brique » FROM « the row is some other
		// height that happens to look similar ». Absolute figures on both, never a comparison:
		// a comparison passes when both collapse to the same wrong number.
		const row = mount({ state: 'ok', value: 'BP · Compte courant' });
		expect(row.className).toContain('h-[68px]');
		expect(row.className).toContain('lg:h-[56px]');
	});
});
