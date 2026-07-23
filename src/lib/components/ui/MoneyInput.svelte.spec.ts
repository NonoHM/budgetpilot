import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
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
});
