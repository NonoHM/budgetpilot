import { page, userEvent } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Modal from './Modal.svelte';

function bodySnippet() {
	return createRawSnippet(() => ({
		render: () => '<button type="button">Inside</button>'
	}));
}

describe('Modal.svelte', () => {
	it('renders the close button with the expected accessible name', async () => {
		render(Modal, { open: true, title: 'Titre', onClose: vi.fn(), children: bodySnippet() });

		await expect.element(page.getByRole('button', { name: 'Fermer' })).toBeInTheDocument();
	});

	it('calls onClose when the close button is clicked', async () => {
		const onClose = vi.fn();
		render(Modal, { open: true, title: 'Titre', onClose, children: bodySnippet() });

		await userEvent.click(page.getByRole('button', { name: 'Fermer' }));

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('calls onClose on Escape', async () => {
		const onClose = vi.fn();
		render(Modal, { open: true, title: 'Titre', onClose, children: bodySnippet() });

		await userEvent.keyboard('{Escape}');

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('moves focus inside the dialog when opened', async () => {
		render(Modal, { open: true, title: 'Titre', onClose: vi.fn(), children: bodySnippet() });

		const closeButton = page.getByRole('button', { name: 'Fermer' }).element();
		expect(document.activeElement).toBe(closeButton);
	});

	it('traps Tab focus within the dialog', async () => {
		render(Modal, { open: true, title: 'Titre', onClose: vi.fn(), children: bodySnippet() });

		const closeButton = page.getByRole('button', { name: 'Fermer' }).element() as HTMLElement;
		const insideButton = page.getByRole('button', { name: 'Inside' }).element() as HTMLElement;

		insideButton.focus();
		expect(document.activeElement).toBe(insideButton);

		await userEvent.tab();
		expect(document.activeElement).toBe(closeButton);
	});

	it('traps Shift+Tab focus within the dialog (reverse direction)', async () => {
		render(Modal, { open: true, title: 'Titre', onClose: vi.fn(), children: bodySnippet() });

		const closeButton = page.getByRole('button', { name: 'Fermer' }).element() as HTMLElement;
		const insideButton = page.getByRole('button', { name: 'Inside' }).element() as HTMLElement;

		// The close button is the first focusable element on open; Shift+Tab from there must
		// wrap around to the last focusable element (Inside) instead of leaving the dialog.
		expect(document.activeElement).toBe(closeButton);

		await userEvent.tab({ shift: true });
		expect(document.activeElement).toBe(insideButton);
	});

	it('restores focus to the triggering element after closing', async () => {
		const trigger = document.createElement('button');
		trigger.textContent = 'Open modal';
		document.body.appendChild(trigger);
		trigger.focus();
		expect(document.activeElement).toBe(trigger);

		const { rerender } = render(Modal, {
			open: false,
			title: 'Titre',
			onClose: vi.fn(),
			children: bodySnippet()
		});

		await rerender({ open: true, title: 'Titre', onClose: vi.fn(), children: bodySnippet() });
		const closeButton = page.getByRole('button', { name: 'Fermer' }).element() as HTMLElement;
		expect(document.activeElement).toBe(closeButton);

		await rerender({ open: false, title: 'Titre', onClose: vi.fn(), children: bodySnippet() });
		expect(document.activeElement).toBe(trigger);

		trigger.remove();
	});
});
