import { page, userEvent } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import TapLink from './TapLink.svelte';

function textSnippet(text: string) {
	return createRawSnippet(() => ({
		render: () => `<span>${text}</span>`
	}));
}

describe('TapLink.svelte', () => {
	it('renders an <a> with the given href when href is passed', async () => {
		render(TapLink, { href: '/budgets', children: textSnippet('Voir tout') });

		const link = page.getByRole('link', { name: 'Voir tout' });
		await expect.element(link).toBeInTheDocument();
		await expect.element(link).toHaveAttribute('href', '/budgets');
	});

	it('renders a type="button" <button> and calls onclick when no href is passed', async () => {
		const onclick = vi.fn();
		render(TapLink, { onclick, children: textSnippet('Modifier') });

		const button = page.getByRole('button', { name: 'Modifier' });
		await expect.element(button).toHaveAttribute('type', 'button');
		await userEvent.click(button);

		expect(onclick).toHaveBeenCalledTimes(1);
	});

	it('renders type="submit" when type is passed, for use as a real form submit control', async () => {
		render(TapLink, { type: 'submit', children: textSnippet('Se déconnecter') });

		const button = page.getByRole('button', { name: 'Se déconnecter' });
		await expect.element(button).toHaveAttribute('type', 'submit');
	});

	it('applies the danger tone color class, distinct from the default tone', async () => {
		const { unmount } = render(TapLink, {
			onclick: vi.fn(),
			tone: 'danger',
			children: textSnippet('Supprimer')
		});
		const dangerButton = page.getByRole('button', { name: 'Supprimer' });
		await expect.element(dangerButton).toHaveClass(/text-rose-700/);
		unmount();

		render(TapLink, { onclick: vi.fn(), children: textSnippet('Modifier') });
		const defaultButton = page.getByRole('button', { name: 'Modifier' });
		await expect.element(defaultButton).toHaveClass(/text-zinc-700/);
	});

	it('disabled button variant: native disabled, onclick not fired', async () => {
		const onclick = vi.fn();
		render(TapLink, { onclick, disabled: true, children: textSnippet('Annuler') });

		const button = page.getByRole('button', { name: 'Annuler' });
		await expect.element(button).toBeDisabled();
		expect(onclick).not.toHaveBeenCalled();
	});

	// `id` exists so something else can reference this link — /upcoming-bills moves focus to a
	// restore link by id after a mutation. Asserted in BOTH render modes: the component picks its
	// element from `href`, so forwarding the id on only one of the two branches is a silent
	// focus-lands-on-nothing bug.
	it('forwards id on the anchor variant', async () => {
		render(TapLink, {
			id: 'bill-restore-x',
			href: '/upcoming-bills',
			children: textSnippet('Rétablir')
		});

		const link = page.getByRole('link', { name: 'Rétablir' });
		await expect.element(link).toHaveAttribute('id', 'bill-restore-x');
	});

	it('forwards id on the button variant, including while disabled', async () => {
		render(TapLink, { id: 'bill-restore-y', disabled: true, children: textSnippet('Rétablir') });

		const el = document.getElementById('bill-restore-y');
		expect(el).not.toBeNull();
		expect(el?.tagName).toBe('BUTTON');
		expect((el as HTMLButtonElement).disabled).toBe(true);
	});

	it('sets no id attribute when the prop is omitted', async () => {
		render(TapLink, { onclick: vi.fn(), children: textSnippet('Modifier') });

		const button = await page.getByRole('button', { name: 'Modifier' }).element();
		expect(button.hasAttribute('id')).toBe(false);
	});

	it('disabled anchor variant: href dropped, aria-disabled set, out of the tab order', async () => {
		render(TapLink, { href: '/budgets', disabled: true, children: textSnippet('Voir tout') });

		// Without href the element loses the implicit link role but must stay
		// announced: query by text, then assert the disabled-link contract.
		const el = page.getByText('Voir tout').element().closest('a');
		expect(el).not.toBeNull();
		expect(el?.hasAttribute('href')).toBe(false);
		expect(el?.getAttribute('aria-disabled')).toBe('true');
		expect(el?.getAttribute('tabindex')).toBe('-1');
	});
});
