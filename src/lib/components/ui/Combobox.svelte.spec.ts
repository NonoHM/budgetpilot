import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Combobox from './Combobox.svelte';
import '../../../routes/layout.css';

/**
 * The `size` prop, added for design 1k: « tous les contrôles passent à 48 px, le plancher de 44
 * l'emporte sans exception d'écran ». Before it, the only way to reach 48 was `triggerClass="h-12"`,
 * appended to a class string that already contains `h-11` — which leaves the winner to Tailwind's
 * generated source order rather than to anything written at the call site. That fails by silently
 * changing height, not by going red, which is why it is a prop.
 *
 * Measured, not read off the class list. A class name is evidence that a rule was requested; the
 * computed height is evidence it won. Those are different claims, and this repo has been caught by
 * the difference before.
 */
describe('Combobox.svelte — field height', () => {
	const options = [
		{ value: 'alimentation', label: 'Alimentation' },
		{ value: 'maison', label: 'Maison' }
	];

	function heightOf(ariaLabel: string) {
		const input = page.getByRole('combobox', { name: ariaLabel }).element() as HTMLElement;
		return input.getBoundingClientRect().height;
	}

	it('is 44px by default — the app-wide touch-target floor, and every existing caller', async () => {
		render(Combobox, { options, ariaLabel: 'Catégorie' });
		await expect.element(page.getByRole('combobox', { name: 'Catégorie' })).toBeInTheDocument();
		expect(heightOf('Catégorie')).toBe(44);
	});

	it('is 48px at size="lg", which the mobile sheet requires of every control', async () => {
		render(Combobox, { options, ariaLabel: 'Catégorie de la part 1', size: 'lg' });
		await expect
			.element(page.getByRole('combobox', { name: 'Catégorie de la part 1' }))
			.toBeInTheDocument();
		expect(heightOf('Catégorie de la part 1')).toBe(48);
	});
});

/**
 * `softDisabled`, added for design 1j: the parent category selector of a répartie transaction
 * « se neutralise sur place », in the card it belongs to, rather than disappearing or refusing
 * after the fact.
 *
 * It is the fourth control in this app to take the prop, after `Button`, `IconButton` and the
 * bulk-tag trigger, and it takes it for the reason 1q makes law: **every** neutralised control in
 * the app is `aria-disabled` and therefore focusable, so it can carry the sentence that explains
 * it. A native `disabled` combobox is unreachable by keyboard and therefore mute — the shape
 * CLAUDE.md already records four sightings of, and this would have been the fifth.
 */
describe('Combobox.svelte — softDisabled (1j, 1q)', () => {
	const options = [
		{ value: 'alimentation', label: 'Alimentation' },
		{ value: 'maison', label: 'Maison' }
	];

	// By LABEL, not by role: a locked field is a readonly textbox, not a combobox. See the component
	// comment — a `role="combobox"` that never expands announces "collapsed" and answers no Alt+Down.
	function lockedEl(name: string) {
		return page.getByLabelText(name).element() as HTMLInputElement;
	}

	it('cannot open its list — proven by opening it FIRST, then locking it', async () => {
		// A negative assertion that has never seen the thing appear proves nothing: it passes while
		// the portal is still empty, while bits-ui has not mounted, while nothing has flushed. So the
		// list is opened for real, with the same gesture and the same selector, BEFORE it is asserted
		// gone. Appear-then-disappear, never absence-then-hope.
		const { rerender } = render(Combobox, {
			options,
			ariaLabel: 'Catégorie',
			value: 'alimentation'
		});

		await userEvent.click(page.getByRole('button', { name: 'Ouvrir la liste' }));
		await expect.element(page.getByRole('option', { name: 'Maison' })).toBeInTheDocument();

		await rerender({ options, ariaLabel: 'Catégorie', value: 'alimentation', softDisabled: true });
		await expect.element(page.getByRole('option', { name: 'Maison' })).not.toBeInTheDocument();

		// And the gesture that opened it a moment ago is gone with it: no trigger to press, and a
		// field that refuses the keystrokes that would filter the list. Asserting the list's absence
		// alone would leave a locked control that still opens on Enter.
		await expect
			.element(page.getByRole('button', { name: 'Ouvrir la liste' }))
			.not.toBeInTheDocument();
		expect(lockedEl('Catégorie').readOnly).toBe(true);
		// And it no longer claims to BE a combobox. A collapsed combobox with no popup is a control
		// that invites a gesture it cannot answer.
		await expect.element(page.getByRole('combobox', { name: 'Catégorie' })).not.toBeInTheDocument();
	});

	it('is neutralised but not mute: aria-disabled, focusable, and pointed at its reason', async () => {
		render(Combobox, {
			options,
			ariaLabel: 'Catégorie',
			value: 'alimentation',
			softDisabled: true,
			'aria-describedby': 'lock-sentence'
		});

		const el = lockedEl('Catégorie');
		expect(el.getAttribute('aria-disabled')).toBe('true');
		expect(el.hasAttribute('disabled')).toBe(false);
		expect(el.getAttribute('aria-describedby')).toBe('lock-sentence');

		// Focusable is the whole point of aria-disabled over disabled: a control that cannot be
		// reached cannot state its reason. `tabIndex` is read rather than asserted through a Tab
		// press because Playwright refuses to interact with an aria-disabled element at all.
		expect(el.tabIndex).toBeGreaterThanOrEqual(0);
		el.focus();
		expect(document.activeElement).toBe(el);
	});

	it('still shows the selected label, and does not change height when it locks', async () => {
		// Relational, deliberately: the figure that matters is not "44" on its own but that the
		// neutralised control agrees with the live one. A lock that changed height by a pixel would
		// make the whole card jump at the moment of removal, which is the exact thing 1j puts the
		// selector in situ to avoid.
		const { rerender } = render(Combobox, { options, ariaLabel: 'Catégorie', value: 'maison' });
		await expect.element(page.getByRole('combobox', { name: 'Catégorie' })).toBeInTheDocument();
		const live = (
			page.getByRole('combobox', { name: 'Catégorie' }).element() as HTMLElement
		).getBoundingClientRect();

		await rerender({ options, ariaLabel: 'Catégorie', value: 'maison', softDisabled: true });
		const locked = lockedEl('Catégorie');

		expect(locked.value).toBe('Maison');
		expect(locked.getBoundingClientRect().height).toBe(live.height);
		expect(locked.getBoundingClientRect().width).toBe(live.width);
	});
});
