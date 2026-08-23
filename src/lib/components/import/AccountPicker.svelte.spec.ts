import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import * as m from '$lib/paraglide/messages';
import AccountPicker from './AccountPicker.svelte';

/**
 * The panel the account row opens: brique 10's listbox with the two clauses 6f names.
 *
 * Every assertion states the TWO STATES it separates. A break-check proves a test can redden; it
 * does not prove it reddens for the reason it names.
 *
 * Strings come from the catalogue, never retyped: a retyped French literal asserts something an
 * English locale never renders, and puts the test and the thing under test on one source.
 *
 * `layout.css` is imported because the heights below are real measurements. Without it the
 * assertions read plausible numbers instead of failing.
 */

const ACCOUNTS = [
	{ id: 'a1', name: 'BP · Compte courant', discriminant: '4417', transactionCount: 128 },
	{ id: 'a2', name: 'BP · Livret A', discriminant: '9032', transactionCount: 12 },
	{ id: 'a3', name: 'Revolut · Perso', discriminant: null, transactionCount: 1 }
];

function mount(props: Record<string, unknown> = {}) {
	const { container } = render(AccountPicker, {
		open: true,
		options: ACCOUNTS,
		panelId: 'account-panel',
		...props
	});
	container.style.width = '360px';
	return container;
}

function panelOf(container: HTMLElement): HTMLElement {
	const panel = container.querySelector('[data-testid="account-panel"]');
	if (!panel) throw new Error('the panel did not render');
	return panel as HTMLElement;
}

describe('the account picker panel', () => {
	it("puts each option's second line INSIDE its accessible name", async () => {
		// SEPARATES: « the discriminant is part of the option's NAME » FROM « the discriminant is a
		// description ». A description can be switched off in a screen reader's settings, and
		// switching it off there removes the only thing separating two accounts at one bank. This is
		// the OPPOSITE treatment from the row's provenance hint, and deliberately so.
		mount();
		const option = page.getByRole('option', {
			name: `BP · Compte courant, ${m.import_account_option_detail_many({ fragment: '4417', count: 128 })}`
		});
		await expect.element(option).toBeInTheDocument();
	});

	it('gives an account with no identifier a second line rather than none', async () => {
		// SEPARATES: « every option has two lines » FROM « an option without a discriminant has one ».
		// Two options on different templates read as two kinds of thing, and the reader cannot tell
		// « this account has no identifier » from « this row is built differently ».
		const container = mount();
		const option = page.getByRole('option', {
			name: `Revolut · Perso, ${m.import_account_option_none()}`
		});
		await expect.element(option).toBeInTheDocument();
		expect(panelOf(container).textContent).toContain(m.import_account_option_none());
	});

	it('announces exactly as many options as there are accounts, never accounts plus one', () => {
		// SEPARATES: « the footer action is a sibling of the listbox » FROM « the footer action is an
		// option ». The second makes a screen reader count one destination too many, and the extra
		// one is not a destination at all. This is 6n's assertion 2 and the structural move of 5d.
		const container = mount();
		const listbox = panelOf(container).querySelector('[role="listbox"]');
		expect(listbox?.querySelectorAll('[role="option"]')).toHaveLength(ACCOUNTS.length);
		expect(listbox?.querySelector('button')).toBeNull();
	});

	it('makes the footer action the LAST tab stop of the panel, after the options', () => {
		// SEPARATES: « the create action comes after every option » FROM « it sits among them ». An
		// action reachable between two options is one an arrow key can land on by accident while
		// choosing, and the plate is explicit that arrows never reach it: Tab does.
		const container = mount();
		const panel = panelOf(container);
		const buttons = [...panel.querySelectorAll('button')];
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.textContent).toContain(m.import_account_new());
		const listbox = panel.querySelector('[role="listbox"]');
		// Narrowed rather than asserted non-null: a missing listbox would otherwise make the line
		// below throw, and a throw is a different failure from « the action is in the wrong place ».
		expect(listbox).not.toBeNull();
		const action = buttons[0] as Node;
		// Node.DOCUMENT_POSITION_FOLLOWING: the button comes after the listbox in document order.
		expect((listbox as Element).compareDocumentPosition(action) & 4).toBeTruthy();
	});

	it('marks the chosen account and opens ON it rather than on the first', () => {
		// SEPARATES: « the panel opens on the account currently chosen » FROM « it opens on the top of
		// the list ». Opening on the first means the arrow keys start somewhere the user did not
		// leave them, and a confirming press changes the value it was meant to confirm.
		const container = mount({ selectedId: 'a2' });
		const listbox = panelOf(container).querySelector('[role="listbox"]');
		const selected = listbox?.querySelector('[aria-selected="true"]');
		expect(selected?.textContent).toContain('BP · Livret A');
		expect(listbox?.getAttribute('aria-activedescendant')).toBe(selected?.id);
		// And selection is carried by a GLYPH, not by the zinc-100 ground alone.
		//
		// FOUND BY THE BREAK MATRIX, not by review: removing the tick left all nine tests green,
		// so the only thing distinguishing the chosen account would have been a background colour.
		// That is information carried by colour and nothing guarded it. SEPARATES « the chosen
		// account is marked » FROM « the chosen account is merely tinted ».
		expect(selected?.querySelector('svg')).not.toBeNull();
	});

	it('shows five options and half of the sixth, with the action pinned out of the scroll', () => {
		// SEPARATES: « the list scrolls internally and says so by cutting a row » FROM « the list ends
		// in a clean edge ». A clean edge at the fifth row is a claim that there are five accounts.
		// Absolute figure: 5.5 rows of 56 px at this width, which is 308 px, never a comparison.
		const container = mount({
			options: [...ACCOUNTS, ...ACCOUNTS.map((a) => ({ ...a, id: `${a.id}-bis` }))]
		});
		const panel = panelOf(container);
		const listbox = panel.querySelector('[role="listbox"]') as HTMLElement;
		expect(getComputedStyle(listbox).maxHeight).toBe('308px');
		expect(getComputedStyle(listbox).overflowY).toBe('auto');
		// The action is OUTSIDE that scrolling box, so it cannot scroll away from the reader.
		expect(listbox.contains(panel.querySelector('button'))).toBe(false);
	});

	it('is 56 px per option at 390 and 48 at 1280, and 48 for the action at both', () => {
		// SEPARATES: « the option is the two-line height 6f measured » FROM « it kept brique 10's
		// one-line 34 px ». Absolute figures on both, never a comparison: a comparison passes when
		// both sides collapse to the same wrong number.
		const container = mount();
		const option = panelOf(container).querySelector('[role="option"]') as HTMLElement;
		expect(option.className).toContain('h-14');
		expect(option.className).toContain('lg:h-12');
		expect((panelOf(container).querySelector('button') as HTMLElement).className).toContain('h-12');
	});

	it('offers the create action alone when the user has no account yet', () => {
		// SEPARATES: « an empty panel is one line of action » FROM « an empty panel is a full-card
		// empty state ». A panel of one line does not need brique 7, and the only possible action is
		// the only visible thing. This is the cell where the user has the least context.
		const container = mount({ options: [] });
		const panel = panelOf(container);
		expect(panel.querySelectorAll('[role="option"]')).toHaveLength(0);
		expect(panel.textContent).toContain(m.import_account_new());
	});

	it('renders nothing at all while closed', () => {
		// SEPARATES: « closed means absent from the tree » FROM « closed means visually hidden ». A
		// hidden-but-present panel keeps its options in the accessibility tree and in the tab order,
		// so a keyboard user tabs through accounts that are not on screen.
		const container = mount({ open: false });
		expect(container.querySelector('[data-testid="account-panel"]')).toBeNull();
	});
});
