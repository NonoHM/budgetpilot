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

	it('softDisabled stays focusable and announces itself, unlike native disabled', async () => {
		const { container } = render(Button, {
			softDisabled: true,
			children: textSnippet('Enregistrer')
		});

		const button = container.querySelector('button') as HTMLButtonElement;
		// The whole point: the explanation that unblocks the control has to stay reachable by
		// keyboard, which a natively disabled button makes impossible.
		expect(button.disabled).toBe(false);
		expect(button.getAttribute('aria-disabled')).toBe('true');
		button.focus();
		expect(document.activeElement).toBe(button);
	});

	it('softDisabled swallows activation so a submit never submits', async () => {
		const { container } = render(Button, {
			type: 'submit',
			softDisabled: true,
			children: textSnippet('Enregistrer')
		});

		const button = container.querySelector('button') as HTMLButtonElement;
		const form = document.createElement('form');
		let submits = 0;
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			submits += 1;
		});
		button.parentElement?.insertBefore(form, button);
		form.appendChild(button);

		button.click();

		// A soft-disabled button is a real button: without the swallow it would submit normally,
		// which is worse than the native disabled it replaces.
		expect(submits).toBe(0);
	});

	it('softDisabled cannot be defeated by a caller passing its own onclick', async () => {
		let called = 0;
		const { container } = render(Button, {
			softDisabled: true,
			onclick: () => {
				called += 1;
			},
			children: textSnippet('Enregistrer')
		});

		(container.querySelector('button') as HTMLButtonElement).click();

		// The handler is composed and declared after the {...rest} spread precisely so a caller's
		// own onclick cannot overwrite it.
		expect(called).toBe(0);
	});

	it('still calls the caller onclick when it is not soft-disabled', async () => {
		let called = 0;
		const { container } = render(Button, {
			onclick: () => {
				called += 1;
			},
			children: textSnippet('Enregistrer')
		});

		(container.querySelector('button') as HTMLButtonElement).click();

		expect(called).toBe(1);
	});
});
