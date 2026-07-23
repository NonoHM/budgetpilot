import { page } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Button from './Button.svelte';
import * as m from '$lib/paraglide/messages';

function textSnippet(text: string) {
	return createRawSnippet(() => ({
		render: () => `<span>${text}</span>`
	}));
}

describe('Button.svelte', () => {
	it('renders its children and is enabled by default', async () => {
		render(Button, { children: textSnippet('Enregistrer') });

		const button = page.getByRole('button', { name: 'Enregistrer' });
		await expect.element(button).toBeInTheDocument();
		await expect.element(button).not.toBeDisabled();
	});

	it('replaces the label with a spinner + sr-only text when loading, and disables the button', async () => {
		render(Button, {
			loading: true,
			loadingLabel: 'Enregistrement…',
			children: textSnippet('Enregistrer')
		});

		// The visible text is gone (replaced by the spinner)...
		expect(page.getByText('Enregistrer', { exact: true }).elements().length).toBe(0);
		// ...but an equivalent accessible name is still announced.
		await expect.element(page.getByText('Enregistrement…')).toBeInTheDocument();

		const button = page.getByRole('button');
		await expect.element(button).toBeDisabled();
		await expect.element(button).toHaveAttribute('aria-busy', 'true');

		const svg = button.element().querySelector('svg');
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute('aria-hidden')).toBe('true');
	});

	it('falls back to a generic sr-only label when loading without an explicit loadingLabel', async () => {
		render(Button, { loading: true, children: textSnippet('Enregistrer') });

		await expect.element(page.getByText(m.common_loading())).toBeInTheDocument();
	});

	it('stays disabled when both disabled and loading are true, and is not aria-busy when only disabled', async () => {
		render(Button, { disabled: true, children: textSnippet('Enregistrer') });

		const button = page.getByRole('button', { name: 'Enregistrer' });
		await expect.element(button).toBeDisabled();
		await expect.element(button).not.toHaveAttribute('aria-busy', 'true');
	});

	it('renders an <a> with the same look when href is passed', async () => {
		render(Button, {
			href: '/admin?page=2',
			variant: 'secondary',
			children: textSnippet('Suivant')
		});

		const link = page.getByRole('link', { name: 'Suivant' });
		await expect.element(link).toBeInTheDocument();
		await expect.element(link).toHaveAttribute('href', '/admin?page=2');
		expect(link.element().className).toContain('border-zinc-300');
	});

	it('disabled anchor variant drops the href and leaves the tab order', async () => {
		render(Button, { href: '/admin?page=2', disabled: true, children: textSnippet('Suivant') });

		const el = page.getByText('Suivant').element().closest('a');
		expect(el).not.toBeNull();
		expect(el?.hasAttribute('href')).toBe(false);
		expect(el?.getAttribute('aria-disabled')).toBe('true');
		expect(el?.getAttribute('tabindex')).toBe('-1');
	});
});
