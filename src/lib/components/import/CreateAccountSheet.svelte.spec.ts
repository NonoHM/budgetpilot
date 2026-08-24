import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import * as m from '$lib/paraglide/messages';
import CreateAccountSheet from './CreateAccountSheet.svelte';

/**
 * The create sheet, 6g's three times.
 *
 * Every assertion names the TWO STATES it separates. A break-check proves a test can redden; it
 * does not prove it reddens for the reason it names, and an assertion whose two states cannot be
 * named is claiming that something happened rather than which thing.
 *
 * The strings come from the catalogue rather than being retyped: a retyped French literal asserts
 * something an English locale never renders, and puts the catalogue and the test on one source.
 *
 * `layout.css` is imported because two assertions below are real measurements.
 */

function mount(props: Record<string, unknown> = {}) {
	return render(CreateAccountSheet, { open: true, ...props });
}

const field = () => page.getByRole('textbox', { name: m.import_account_create_field() });

describe('the create account sheet', () => {
	it('opens with the name the file suggested, editable rather than fixed', async () => {
		// SEPARATES: « the prefill is a suggestion under the user's hand » FROM « the prefill is a
		// value they have to accept ». 6g draws the distinction itself: prefilling a NAME in a sheet
		// the user opened deliberately saves them a keystroke, and it is only a commodity while it
		// stays editable before an explicit press.
		mount({ prefill: 'Banque Populaire ···4417' });
		const input = field();
		await expect.element(input).toBeInTheDocument();
		expect((input.element() as HTMLInputElement).value).toBe('Banque Populaire ···4417');
		expect((input.element() as HTMLInputElement).disabled).toBe(false);
	});

	it('opens EMPTY and still enabled when the file said nothing', async () => {
		// SEPARATES: « the field is empty and the user can act » FROM « the field is disabled and the
		// user meets a wall ». This is the cell where they have the least context, so a wall is the
		// worst answer available. DEVIATION from 6g's « jamais vide », recorded: with no institution
		// and no fragment there is nothing to prefill FROM, and both alternatives fabricate a name
		// from something that is not about the user's bank.
		mount({ prefill: '' });
		const input = field();
		expect((input.element() as HTMLInputElement).value).toBe('');
		expect((input.element() as HTMLInputElement).disabled).toBe(false);
		// And the hint says what a good name LOOKS LIKE rather than that the field is required.
		expect(document.body.textContent).toContain(m.import_account_create_hint_examples());
	});

	it('reveals the empty-name error at the PRESS, never by grey', async () => {
		// SEPARATES: « the primary stays pressable and the press explains » FROM « the primary is
		// disabled and explains nothing ». The plate's transverse rule, which this plate applies and
		// does not impose. A greyed control cannot be asked why.
		const onSubmit = vi.fn();
		mount({ prefill: '', onSubmit });
		const primary = page.getByRole('button', { name: m.import_account_create_submit() });
		expect((primary.element() as HTMLButtonElement).disabled).toBe(false);
		await primary.click();
		expect(onSubmit).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain(m.import_account_create_error_name_required());
	});

	/**
	 * THE TWO DIRECTIONS OF THE SAME REGRESSION, PLUS THE GUARD ON THE REMOVAL ITSELF.
	 *
	 * This sheet used to take an `existingNames` list and refuse a held name before the network. It
	 * was equivalent to the server's check only while that list carried the same strings the server
	 * compares. It stopped being one: the picker offers each account under its DISPLAYED name, and
	 * the generic bucket's stored name is a different string. So the two sides disagreed in BOTH
	 * directions on the one account where it matters.
	 *
	 * The list is gone rather than doubled. The criterion is not « the server is authoritative » but
	 * « each side validates only what it can know with certainty »: this side knows what is on
	 * screen, the server knows what is stored, and here those differ by construction.
	 */
	it('accepts a name the old client check REFUSED and the server accepts', async () => {
		// SEPARATES: « the name reaches the caller » FROM « the sheet answered from a list ». The
		// displayed name of the generic bucket is what the picker shows and what the old list would
		// have carried; nothing is stored under it, so the server accepts it.
		expect.assertions(2);
		const onSubmit = vi.fn();
		mount({ prefill: m.accounts_generic_bucket(), onSubmit });
		await page.getByRole('button', { name: m.import_account_create_submit() }).click();
		expect(onSubmit).toHaveBeenCalledWith(m.accounts_generic_bucket());
		// The companion: the sheet has not simply gone inert. It still refuses an empty name, so the
		// green above separates « it deferred » from « the primary does nothing at all ».
		expect(document.body.textContent).not.toContain(m.import_account_create_error_name_taken());
	});

	it('sends a name the old client check ACCEPTED and the server refuses', async () => {
		// SEPARATES: « the sheet defers » FROM « the sheet decides from a list that cannot know ».
		// The STORED name is absent from anything the client can see, so a local check waved it
		// through and the server refused a moment later: two answers for one question.
		expect.assertions(1);
		const onSubmit = vi.fn();
		mount({ prefill: 'Compte import CSV', onSubmit });
		await page.getByRole('button', { name: m.import_account_create_submit() }).click();
		expect(onSubmit).toHaveBeenCalledWith('Compte import CSV');
	});

	it('HAS NO LIST TO CONSULT: handed one, it still submits', async () => {
		// SEPARATES: « the component takes no name list » FROM « it takes one and this suite never
		// passes it ». The two earlier tests both pass while the list exists and simply is not given,
		// so neither of them guards the REMOVAL; this one hands the sheet exactly the list the caller
		// used to pass, under the name it used to pass it, and requires the name through anyway.
		//
		// It is written as an unknown prop deliberately. Svelte ignores one, so this is green while
		// the prop is absent and red the moment somebody re-adds it as an optimisation, which is the
		// thing the comment in the component asks them not to do.
		expect.assertions(1);
		const onSubmit = vi.fn();
		mount({ prefill: 'Livret A', existingNames: ['Livret A'], onSubmit });
		await page.getByRole('button', { name: m.import_account_create_submit() }).click();
		expect(onSubmit).toHaveBeenCalledWith('Livret A');
	});

	it("renders the SERVER's refusal, which is the sentence the user reads", async () => {
		// SEPARATES: « the reason comes back from the side that knows » FROM « the sheet invented
		// one ». With the check gone, the only refusal a duplicate can produce is this one, so it
		// has to be readable and has to leave the typed name in the field to correct.
		expect.assertions(2);
		mount({
			prefill: 'Compte import CSV',
			state: 'error',
			error: m.import_account_create_error_name_taken()
		});
		expect(document.body.textContent).toContain(m.import_account_create_error_name_taken());
		expect((field().element() as HTMLInputElement).value).toBe('Compte import CSV');
	});

	it('sends the trimmed name once it is not empty', async () => {
		// SEPARATES: « a valid name reaches the caller » FROM « the sheet refuses everything ». The
		// calibration the four refusals above need: without it each of them is equally explained by
		// a primary that never submits at all.
		const onSubmit = vi.fn();
		mount({ prefill: '  Livret A  ', existingNames: ['Compte courant'], onSubmit });
		await page.getByRole('button', { name: m.import_account_create_submit() }).click();
		expect(onSubmit).toHaveBeenCalledWith('Livret A');
	});

	it('in flight, names the action, stays focusable and freezes its width', async () => {
		// SEPARATES: « the button carries 5f's occupancy contract » FROM « the button shows a bare
		// spinner ». A disabled button leaves the tab order and announces nothing, which sends focus
		// to the body at the exact moment the user is waiting for an answer where they pressed.
		mount({ prefill: 'Livret A', state: 'busy' });
		const primary = page.getByRole('button', { name: m.import_account_create_submitting() });
		await expect.element(primary).toBeInTheDocument();
		const element = primary.element() as HTMLButtonElement;
		expect(element.getAttribute('aria-busy')).toBe('true');
		expect(element.disabled).toBe(false);
	});

	it('in flight, Cancel is inert and the sheet is still there', async () => {
		// SEPARATES: « cancelling is swallowed while the request is out » FROM « cancelling closes
		// the sheet over a request nothing can recall ». A dismissal that cancels nothing and hides
		// the answer is not a dismissal.
		const onCancel = vi.fn();
		mount({ prefill: 'Livret A', state: 'busy', onCancel });
		const cancel = page.getByRole('button', { name: m.common_cancel() });
		// Clicked DIRECTLY rather than through the locator: Playwright treats `aria-disabled="true"`
		// as not enabled and waits for it to become enabled, which never happens, so the ordinary
		// `.click()` times out instead of measuring anything. Recorded trap.
		(cancel.element() as HTMLButtonElement).click();
		expect(onCancel).not.toHaveBeenCalled();
		expect(cancel.element().getAttribute('aria-disabled')).toBe('true');
	});

	it('on failure keeps the sheet, keeps the input and offers the retry', async () => {
		// SEPARATES: « the failure left the work in place » FROM « the failure lost it ». The user is
		// in the middle of an import and has just seen something else fail; the sentence has to say
		// what survived, or the failure reads as the loss of the designation work.
		mount({ prefill: 'Livret A', state: 'error', error: m.import_account_create_error_generic() });
		expect((field().element() as HTMLInputElement).value).toBe('Livret A');
		expect(document.body.textContent).toContain(m.import_account_create_error_generic());
		await expect.element(page.getByRole('button', { name: m.error_retry() })).toBeInTheDocument();
	});

	it('puts the failure between the field and the footer, and takes the focus to it', async () => {
		// SEPARATES: « the banner is reachable and announced » FROM « it is announced only ». Those
		// are two mechanisms that fail separately: `role="alert"` reads the sentence out and moves
		// nobody, so a keyboard user is left reading a message whose actions they must hunt for.
		// 6g: « la feuille ne ferme pas, le focus va au bandeau ».
		mount({ prefill: 'Livret A', state: 'error', error: m.import_account_create_error_generic() });
		const alert = page.getByRole('alert');
		await expect.element(alert).toBeInTheDocument();
		const input = field().element();
		const primary = page.getByRole('button', { name: m.error_retry() }).element();
		// DOM order, asserted rather than read off the pixels: the banner is after the field and
		// before the primary. Two comparisons, because one of them alone passes when the banner sits
		// outside the form entirely.
		expect(input.compareDocumentPosition(alert.element())).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(alert.element().compareDocumentPosition(primary)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(document.activeElement && alert.element().contains(document.activeElement)).toBe(true);
	});

	it('is a full-width sheet at 390 and a 340 modal at 1280', async () => {
		// SEPARATES: « the panel carries the plate's two widths » FROM « it carries brique 15's
		// default 512 ». Absolute figures, never a comparison: a comparison passes when both sides
		// collapse to the same wrong number. 6h's responsive line is the source.
		mount({ prefill: 'Livret A' });
		const panel = page.getByRole('dialog').element();
		expect(panel.className).toContain('lg:max-w-[340px]');
		expect(panel.className).toContain('w-full');
	});

	it('puts the caret in the name field when it opens, not on the close control', async () => {
		// SEPARATES: « the sheet opens ready to be typed into » FROM « it opens with the focus on its
		// own dismissal ». Brique 15 focuses the FIRST focusable in the dialog, which is its header's
		// close control, and that is right for a dialog that asks a question and wrong for a form with
		// one field: the user opened this deliberately in order to type.
		//
		// FOUND BY SCREENSHOT, on the built page, with every other assertion in this file green. It is
		// worse than it looks at 390, where the compact variant renders that close control `sr-only`:
		// the sheet opens with the focus on a control nobody can see, so there is no focus ring on
		// screen at all and Tab appears to start from nowhere.
		mount({ prefill: 'Banque Populaire ···4417' });
		await expect.element(field()).toBeInTheDocument();
		expect(document.activeElement).toBe(field().element());
		// And the prefill is SELECTED rather than merely present, so the first keystroke replaces a
		// suggestion instead of appending to it. A suggestion the user has to clear by hand is a
		// suggestion that costs more than it saves.
		const input = field().element() as HTMLInputElement;
		expect([input.selectionStart, input.selectionEnd]).toStrictEqual([0, input.value.length]);
	});

	it('bounds the field at the length the column accepts', async () => {
		// SEPARATES: « the field cannot produce a name the server refuses » FROM « it can, and the
		// user learns the bound only after pressing ». The server refusal still exists, because a
		// hand-made request is not a form; this is the affordance that keeps an ordinary user out of
		// it.
		mount({ prefill: '' });
		expect((field().element() as HTMLInputElement).maxLength).toBe(120);
	});
});
