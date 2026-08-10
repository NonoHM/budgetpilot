import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
// Load-bearing for the geometry test below, and NOT optional because that test is relational: with
// no stylesheet both renders fall back to the same UA defaults, so the comparison passes for a
// reason that has nothing to do with the component's own classes. Break-checked 2026-08-07 — giving
// the locked branch a different height class is invisible without this import and named with it.
import '../../../routes/layout.css';
import MoneyInput from './MoneyInput.svelte';

describe('MoneyInput.svelte', () => {
	it('renders a real associated label for the amount field', async () => {
		render(MoneyInput, { name: 'amount', label: 'Montant' });

		const input = page.getByLabelText('Montant');
		await expect.element(input).toBeInTheDocument();
	});

	it('renders the € suffix as decorative (aria-hidden)', async () => {
		const { container } = render(MoneyInput, { name: 'amount', label: 'Montant' });

		const suffix = Array.from(container.querySelectorAll('span')).find(
			(el) => el.textContent?.trim() === '€'
		);
		expect(suffix).not.toBeUndefined();
		expect(suffix?.getAttribute('aria-hidden')).toBe('true');
	});

	it('uses inputmode="decimal" and type="text" (never type="number")', async () => {
		render(MoneyInput, { name: 'amount', label: 'Montant' });

		const input = page.getByLabelText('Montant').element() as HTMLInputElement;
		expect(input.type).toBe('text');
		expect(input.getAttribute('inputmode')).toBe('decimal');
	});

	it('sets the name attribute for form submission', async () => {
		render(MoneyInput, { name: 'targetAmount', label: 'Montant' });

		const input = page.getByLabelText('Montant').element() as HTMLInputElement;
		expect(input.name).toBe('targetAmount');
	});

	it('applies a fixed 44px (h-11) touch target height', async () => {
		render(MoneyInput, { name: 'amount', label: 'Montant' });

		const input = page.getByLabelText('Montant').element() as HTMLInputElement;
		expect(input.className).toContain('h-11');
	});

	it('exposes allowZero/allowNegative as data attributes for callers/tests, never as min (inert on type="text")', async () => {
		render(MoneyInput, { name: 'amount', label: 'Montant', allowZero: true, allowNegative: true });

		const input = page.getByLabelText('Montant').element() as HTMLInputElement;
		expect(input.getAttribute('data-allow-zero')).toBe('true');
		expect(input.getAttribute('data-allow-negative')).toBe('true');
		expect(input.hasAttribute('min')).toBe(false);
	});

	it('does not render an error message by default', async () => {
		const { container } = render(MoneyInput, { name: 'amount', label: 'Montant' });

		expect(container.querySelector('[aria-invalid]')).toBeNull();
	});

	it('links the error message via aria-describedby when error is set', async () => {
		render(MoneyInput, { name: 'amount', label: 'Montant', error: 'Montant invalide' });

		const input = page.getByLabelText('Montant').element() as HTMLInputElement;
		expect(input.getAttribute('aria-invalid')).toBe('true');

		const describedById = input.getAttribute('aria-describedby');
		expect(describedById).toBeTruthy();

		const errorEl = document.getElementById(describedById!);
		expect(errorEl?.textContent).toBe('Montant invalide');

		await expect.element(page.getByText('Montant invalide')).toBeInTheDocument();
	});

	it('renders the hint text when provided', async () => {
		render(MoneyInput, {
			name: 'amount',
			label: 'Montant',
			hint: 'Négatif pour une dépense, positif pour un revenu.'
		});

		await expect
			.element(page.getByText('Négatif pour une dépense, positif pour un revenu.'))
			.toBeInTheDocument();
	});

	it('is required by default', async () => {
		render(MoneyInput, { name: 'amount', label: 'Montant' });

		const input = page.getByLabelText('Montant').element() as HTMLInputElement;
		expect(input.required).toBe(true);
	});

	it('is not required when required=false', async () => {
		render(MoneyInput, { name: 'amount', label: 'Montant', required: false });

		const input = page.getByLabelText('Montant').element() as HTMLInputElement;
		expect(input.required).toBe(false);
	});

	it('prefills the value when passed', async () => {
		render(MoneyInput, { name: 'amount', label: 'Montant', value: '42,50' });

		const input = page.getByLabelText('Montant').element() as HTMLInputElement;
		expect(input.value).toBe('42,50');
	});

	/**
	 * `value` bindable and `oninput` were added for the split editor's live remainder, which has to
	 * move on every keystroke or design 1d and 1p both collapse. They must not turn this into a
	 * controlled/reformatting field: the component's whole contract is that it never reinterprets
	 * what was typed, so what comes back out is the raw string, byte for byte.
	 */
	it('reports every keystroke through oninput, raw and unreformatted', async () => {
		const oninput = vi.fn<(raw: string) => void>();
		render(MoneyInput, { name: 'amount', label: 'Montant', oninput });

		const input = page.getByLabelText('Montant');
		await userEvent.fill(input, '1 234,5');

		expect(oninput).toHaveBeenCalled();
		// The LAST call carries the whole field, and carries it exactly as typed — spaces, comma and
		// a single decimal that no formatter has "helped" into 1 234,50.
		expect(oninput.mock.calls.at(-1)?.[0]).toBe('1 234,5');
	});

	it('does not rewrite what the user typed', async () => {
		// The guard on the paragraph above: a component that echoed a normalised value back into the
		// field would pass the oninput test and still destroy the parser's tolerance.
		render(MoneyInput, { name: 'amount', label: 'Montant' });
		const input = page.getByLabelText('Montant');
		await userEvent.fill(input, '12,5');
		expect((input.element() as HTMLInputElement).value).toBe('12,5');
	});
});

/**
 * `softDisabled`, added for design 1i's saving state: « les champs passent en aria-disabled et non
 * disabled : le focus ne s'évapore pas sous les doigts si la requête traîne ».
 *
 * The sixth control in this app to take the prop, and it takes it for the reason 1q makes law
 * rather than for symmetry. A natively `disabled` input leaves the tab order, so a request that
 * drags would drop the caret out of the field the user was typing in — and CLAUDE.md records four
 * existing sightings of native `disabled` where the rule asks for `aria-disabled`.
 */
describe('MoneyInput.svelte — softDisabled (1i, 1q)', () => {
	it('refuses the keystroke while staying focusable and named', async () => {
		// Typed for real, and the field is proven to ACCEPT typing first with the same gesture and
		// the same selector. Asserting only that a locked field stayed empty passes on a field that
		// was never reachable.
		const { rerender } = render(MoneyInput, { name: 'amount', label: 'Montant', value: '10,00' });
		const live = page.getByLabelText('Montant').element() as HTMLInputElement;
		await userEvent.fill(live, '12,34');
		expect(live.value).toBe('12,34');

		await rerender({ name: 'amount', label: 'Montant', value: '12,34', softDisabled: true });
		const locked = page.getByLabelText('Montant').element() as HTMLInputElement;
		expect(locked.readOnly).toBe(true);
		expect(locked.getAttribute('aria-disabled')).toBe('true');
		expect(locked.hasAttribute('disabled')).toBe(false);

		// Focusable, which is the entire difference from `disabled` and the reason the design names
		// it: the caret does not evaporate mid-request.
		locked.focus();
		expect(document.activeElement).toBe(locked);
		expect(locked.tabIndex).toBeGreaterThanOrEqual(0);
	});

	it('cannot move the live preview under the user, because the keystroke never arrives', async () => {
		// The property, stated over the mechanism: `readonly` fires no input event, so the remainder
		// the callback drives cannot change while the write it belongs to is in flight. Proven by
		// the CONTRAST — the same gesture on the same component does fire when it is not locked —
		// rather than by a lone absence, which would pass on a callback that was never wired.
		const live = vi.fn();
		const first = render(MoneyInput, {
			name: 'amount',
			label: 'Montant',
			value: '10,00',
			oninput: live
		});
		const liveInput = first.container.querySelector('input') as HTMLInputElement;
		liveInput.focus();
		await userEvent.type(liveInput, '9');
		expect(live).toHaveBeenCalled();

		const locked = vi.fn();
		const second = render(MoneyInput, {
			name: 'amount',
			label: 'Montant',
			value: '10,00',
			softDisabled: true,
			oninput: locked
		});
		const lockedInput = second.container.querySelector('input') as HTMLInputElement;
		lockedInput.focus();
		await userEvent.type(lockedInput, '9');
		expect(locked).not.toHaveBeenCalled();
		expect(lockedInput.value).toBe('10,00');
	});

	it('keeps its geometry when it locks, so nothing jumps mid-save', async () => {
		// Relational: the figure that matters is not 44 on its own but that the locked field agrees
		// with the live one. 1i is explicit that the remainder band must not move during the save —
		// a field that changed height would move everything below it.
		const { rerender } = render(MoneyInput, { name: 'amount', label: 'Montant', value: '10,00' });
		await expect.element(page.getByLabelText('Montant')).toBeInTheDocument();
		const live = (page.getByLabelText('Montant').element() as HTMLElement).getBoundingClientRect();

		await rerender({ name: 'amount', label: 'Montant', value: '10,00', softDisabled: true });
		const locked = (
			page.getByLabelText('Montant').element() as HTMLElement
		).getBoundingClientRect();

		expect(locked.height).toBe(live.height);
		expect(locked.width).toBe(live.width);
	});

	it('points a locked field at ONE explanation, and an error still wins it', async () => {
		// 1q: one reason location per neutralised control, never two. A field that is both in error
		// and locked has one describedby, and it is the error — the thing the user has to act on.
		const { rerender } = render(MoneyInput, {
			name: 'amount',
			label: 'Montant',
			value: '10,00',
			softDisabled: true,
			'aria-describedby': 'saving-hint'
		});
		expect(
			(page.getByLabelText('Montant').element() as HTMLElement).getAttribute('aria-describedby')
		).toBe('saving-hint');

		await rerender({
			name: 'amount',
			label: 'Montant',
			value: '10,00',
			softDisabled: true,
			'aria-describedby': 'saving-hint',
			error: 'Montant invalide'
		});
		const described = (page.getByLabelText('Montant').element() as HTMLElement).getAttribute(
			'aria-describedby'
		);
		expect(described).not.toBe('saving-hint');
		expect(document.getElementById(described ?? '')?.textContent).toBe('Montant invalide');
	});
});
