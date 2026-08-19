import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import SwitchRow from './SwitchRow.svelte';

/**
 * Brique 6c, the switch row: a labelled boolean whose VALUE is read before the press.
 *
 * ## Why this is not one of the bricks that already exist
 *
 * Not `CheckboxField` (6b). A checkbox is a value COLLECTED, validated later with the rest of the
 * form, which is exactly its use in Planche 5c. Here the press reconfigures the list on the spot.
 * Merging them would licence immediate-effect checkboxes across the product and dissolve the
 * distinction that protects 5c.
 *
 * Not a toggle button with `aria-pressed` (brique 1's toggle role). A toggle says « I performed an
 * action »; a switch says « here is the state ». The requirement is legibility BEFORE the press,
 * which is the definition of a switch. Brique 1 is also text-free by its own accessibility clause,
 * and this control carries words.
 *
 * Not `Switch.svelte`. That is the knob alone, 44x24 with a 16 px thumb and an `ariaLabel`, and its
 * TARGET is the knob. Here the target is the whole row, and A BUTTON CANNOT CONTAIN A BUTTON: the
 * row is the switch, so the knob has to be drawn inside it rather than composed. Its three callers
 * are untouched.
 */
const BASE = {
	label: 'Première ligne',
	valueLabel: ['données', 'en-têtes'] as [string, string],
	consequence: 'Les colonnes se nomment Date, Libellé, Montant…',
	checked: true,
	onChange: () => {}
};

describe('SwitchRow, the six states of brique 6c', () => {
	// THREE ASSERTIONS AND NOT ONE, because they fail for different reasons: a wrong role is a
	// component bug, a wrong value state is a wiring bug, and a value that is not written in words
	// is the defect the brick exists to remove.
	it('is a switch', async () => {
		const screen = render(SwitchRow, BASE);

		await expect.element(screen.getByRole('switch')).toBeInTheDocument();
	});

	it('carries its value state', async () => {
		const on = render(SwitchRow, BASE);
		expect((await on.getByRole('switch').element()).getAttribute('aria-checked')).toBe('true');

		const off = render(SwitchRow, { ...BASE, checked: false });
		expect((await off.getByRole('switch').last().element()).getAttribute('aria-checked')).toBe(
			'false'
		);
	});

	// The value in WORDS, and this is the whole reason the label changed. « La première ligne
	// contient des données » is a sentence true or false according to a state it does not show: you
	// read an action and you get a value. The brick separates them.
	it('writes its value in words, and the words change with the state', async () => {
		const on = render(SwitchRow, BASE);
		await expect.element(on.getByText('en-têtes')).toBeInTheDocument();

		const off = render(SwitchRow, { ...BASE, checked: false });
		await expect.element(off.getByText('données').last()).toBeInTheDocument();
	});

	// The consequence is written underneath rather than guessed, and it is LINKED rather than being
	// a second name: `aria-describedby`, so it is heard after the name and not instead of it.
	it('links the consequence by aria-describedby, not by name', async () => {
		const screen = render(SwitchRow, BASE);
		const control = await screen.getByRole('switch').element();

		const describedBy = control.getAttribute('aria-describedby');
		expect(describedBy).not.toBeNull();
		expect(document.getElementById(describedBy!)?.textContent).toContain('Les colonnes se nomment');
		// THE ACCESSIBLE NAME is the label and the value, never the consequence sentence. Read from
		// `aria-label` rather than from `textContent`, and the distinction is the point: a <button>
		// takes its name from its contents unless it is named explicitly, so the consequence rendered
		// inside the row WAS the tail of the name until this failed.
		expect(control.getAttribute('aria-label')).toBe('Première ligne, en-têtes');
		expect(control.getAttribute('aria-label')).not.toContain('Les colonnes se nomment');
	});

	// The whole row is the target, 48 px, and it is what the press lights. Sinking a 22 px knob would
	// flash an object smaller than the finger touching it.
	it('is a 48 px row, and the row is what presses', async () => {
		const screen = render(SwitchRow, BASE);
		const control = (await screen.getByRole('switch').element()) as HTMLElement;

		expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);

		control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		expect(control.dataset.pressed).toBe('');
		// 5a's third clause, at the consuming end: the press must not disturb the value state.
		expect(control.getAttribute('aria-checked')).toBe('true');
	});

	// A switch accepts BOTH keys. Asserted separately from the click, because a handler wired only to
	// `onclick` answers Enter on a <button> and never Space, and the reverse for a custom keydown.
	it('toggles on click, on Enter and on Space', async () => {
		const onChange = vi.fn();
		const screen = render(SwitchRow, { ...BASE, onChange });
		const control = (await screen.getByRole('switch').element()) as HTMLElement;

		control.click();
		control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		control.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

		expect(onChange).toHaveBeenCalledTimes(3);
		// The NEXT value, never a bare toggle signal: a caller that has to remember which way it was
		// going is one that can disagree with the control about the state.
		expect(onChange).toHaveBeenLastCalledWith(false);
	});

	// `lockedReason` renders inert AND states the reason, never one without the other. A control
	// switched off that cannot say why is not switched off, it is broken.
	it('locked is inert and states its reason, and the two are one prop', async () => {
		const onChange = vi.fn();
		const screen = render(SwitchRow, {
			...BASE,
			checked: false,
			onChange,
			lockedReason: "Le fichier ne contient qu'une ligne : elle est traitée comme des données."
		});
		const control = (await screen.getByRole('switch').element()) as HTMLElement;

		expect(control.getAttribute('aria-disabled')).toBe('true');
		control.click();
		expect(onChange).not.toHaveBeenCalled();
		await expect.element(screen.getByText(/ne contient qu'une ligne/)).toBeInTheDocument();
		// Still reachable, so it can state its own reason: `aria-disabled`, never the native
		// attribute, which removes the control from the tab order and makes it mute.
		expect(control.hasAttribute('disabled')).toBe(false);
	});

	// The conditional in-flight state of 5f, which is not a state in its own right: past 5000 rows a
	// local re-read can exceed 300 ms. The VALUE is replaced by the word, so nothing is read by
	// colour alone and the row still says what it is doing.
	it('in flight replaces the value with a word and stays a switch', async () => {
		const screen = render(SwitchRow, { ...BASE, busyLabel: 'relecture…' });
		const control = (await screen.getByRole('switch').element()) as HTMLElement;

		await expect.element(screen.getByText('relecture…')).toBeInTheDocument();
		expect(control.getAttribute('aria-busy')).toBe('true');
		expect(control.getAttribute('role')).toBe('switch');
	});

	// The focus ring is brique 1's, unchanged, and it is on the ROW because the row is the control.
	it('takes the focus ring on the row', async () => {
		await page.viewport(390, 844);
		const screen = render(SwitchRow, BASE);
		const control = (await screen.getByRole('switch').element()) as HTMLElement;

		control.focus();
		expect(document.activeElement).toBe(control);
	});
});
