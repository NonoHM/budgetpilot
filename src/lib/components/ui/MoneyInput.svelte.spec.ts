import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
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
