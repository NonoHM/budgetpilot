import { page, userEvent } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import IconButton from './IconButton.svelte';

function iconSnippet() {
	return createRawSnippet(() => ({
		render: () => '<svg aria-hidden="true"><path /></svg>'
	}));
}

describe('IconButton.svelte', () => {
	it('renders aria-label from the label prop', async () => {
		render(IconButton, { label: 'Supprimer', children: iconSnippet() });

		await expect.element(page.getByRole('button', { name: 'Supprimer' })).toBeInTheDocument();
	});

	it('applies the neutral tone color classes by default', async () => {
		render(IconButton, { label: 'Modifier', tone: 'neutral', children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Modifier' }).element();
		expect(button.className).toContain('text-zinc-500');
		expect(button.className).not.toContain('text-rose-600');
	});

	it('applies the danger tone color classes', async () => {
		render(IconButton, { label: 'Supprimer', tone: 'danger', children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Supprimer' }).element();
		expect(button.className).toContain('text-rose-600');
	});

	it('sets aria-pressed=true and the active visual state when pressed=true', async () => {
		render(IconButton, { label: 'Regex', shape: 'box', pressed: true, children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Regex' });
		await expect.element(button).toHaveAttribute('aria-pressed', 'true');
		expect(button.element().className).toContain('bg-zinc-900');
	});

	it('sets aria-pressed=false when pressed=false', async () => {
		render(IconButton, { label: 'Regex', shape: 'box', pressed: false, children: iconSnippet() });

		await expect
			.element(page.getByRole('button', { name: 'Regex' }))
			.toHaveAttribute('aria-pressed', 'false');
	});

	it('omits aria-pressed entirely when pressed is not provided (non-toggle button)', async () => {
		render(IconButton, { label: 'Fermer', children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Fermer' }).element();
		expect(button.hasAttribute('aria-pressed')).toBe(false);
	});

	it('applies distinct classes for the circle shape (default)', async () => {
		render(IconButton, { label: 'Fermer', children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Fermer' }).element();
		expect(button.className).toContain('rounded-full');
		expect(button.className).not.toContain('border');
	});

	it('applies distinct classes for the box shape', async () => {
		render(IconButton, { label: 'Regex', shape: 'box', children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Regex' }).element();
		expect(button.className).toContain('rounded-md');
		expect(button.className).toContain('border');
	});

	it('applies distinct classes for the pill shape', async () => {
		render(IconButton, { label: 'Regex', shape: 'pill', children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Regex' }).element();
		expect(button.className).toContain('rounded-full');
		expect(button.className).toContain('border');
		expect(button.className).toContain('px-2.5');
	});

	it('renders with a minimum 44x44px touch target regardless of shape', async () => {
		render(IconButton, { label: 'Fermer', children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Fermer' }).element();
		expect(button.className).toContain('min-h-11');
		expect(button.className).toContain('min-w-11');
	});

	it('disables the button and does not fire onclick when disabled', async () => {
		const onclick = vi.fn();
		render(IconButton, { label: 'Fermer', disabled: true, onclick, children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Fermer' });
		await expect.element(button).toBeDisabled();
		await userEvent.click(button, { force: true });

		expect(onclick).not.toHaveBeenCalled();
	});

	it('fires onclick when enabled', async () => {
		const onclick = vi.fn();
		render(IconButton, { label: 'Fermer', onclick, children: iconSnippet() });

		await userEvent.click(page.getByRole('button', { name: 'Fermer' }));

		expect(onclick).toHaveBeenCalledTimes(1);
	});

	it('defaults to type="button"', async () => {
		render(IconButton, { label: 'Fermer', children: iconSnippet() });

		await expect
			.element(page.getByRole('button', { name: 'Fermer' }))
			.toHaveAttribute('type', 'button');
	});

	it('renders type="submit" when explicitly set', async () => {
		render(IconButton, { label: 'Envoyer', type: 'submit', children: iconSnippet() });

		await expect
			.element(page.getByRole('button', { name: 'Envoyer' }))
			.toHaveAttribute('type', 'submit');
	});
});
