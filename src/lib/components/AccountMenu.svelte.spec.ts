import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import AccountMenu from './AccountMenu.svelte';

describe('AccountMenu.svelte', () => {
	it('cache le lien Administration pour un utilisateur non admin', async () => {
		render(AccountMenu, { email: 'sophie.martin@gmail.com', isAdmin: false });

		await userEvent.click(page.getByRole('button', { name: 'Menu du compte' }));

		await expect.element(page.getByText('sophie.martin@gmail.com')).toBeInTheDocument();
		await expect
			.element(page.getByRole('menuitem', { name: 'Paramètres' }))
			.toHaveAttribute('href', '/settings');
		await expect
			.element(page.getByRole('menuitem', { name: 'Administration' }))
			.not.toBeInTheDocument();
	});

	it('affiche le lien Administration pour un utilisateur admin', async () => {
		render(AccountMenu, { email: 'admin@budgetpilot.com', isAdmin: true });

		await userEvent.click(page.getByRole('button', { name: 'Menu du compte' }));

		await expect
			.element(page.getByRole('menuitem', { name: 'Administration' }))
			.toHaveAttribute('href', '/admin');
		await expect
			.element(page.getByRole('menuitem', { name: 'Paramètres' }))
			.toHaveAttribute('href', '/settings');
	});

	it('place le bouton de déconnexion dans un formulaire POST vers /logout', async () => {
		render(AccountMenu, { email: 'sophie.martin@gmail.com', isAdmin: false });

		await userEvent.click(page.getByRole('button', { name: 'Menu du compte' }));

		const logoutButton = page.getByRole('menuitem', { name: 'Déconnexion' });
		await expect.element(logoutButton).toBeInTheDocument();

		const form = document.querySelector('form[action="/logout"]');
		expect(form).not.toBeNull();
		expect(form?.getAttribute('method')).toBe('POST');
	});

	it('renders the logout menu item as a real <button type="submit"> inside a real <form>, not a link or a div', async () => {
		render(AccountMenu, { email: 'sophie.martin@gmail.com', isAdmin: false });

		await userEvent.click(page.getByRole('button', { name: 'Menu du compte' }));

		const logoutButton = page.getByRole('menuitem', { name: 'Déconnexion' }).element();
		expect(logoutButton.tagName).toBe('BUTTON');
		expect(logoutButton.getAttribute('type')).toBe('submit');

		const form = logoutButton.closest('form');
		expect(form).not.toBeNull();
		expect(form?.tagName).toBe('FORM');
		expect(form?.getAttribute('method')).toBe('POST');
		expect(form?.getAttribute('action')).toBe('/logout');
	});

	it('submits the real /logout form when Enter is pressed while the logout button is focused', async () => {
		render(AccountMenu, { email: 'sophie.martin@gmail.com', isAdmin: false });

		await userEvent.click(page.getByRole('button', { name: 'Menu du compte' }));

		const logoutButton = page
			.getByRole('menuitem', { name: 'Déconnexion' })
			.element() as HTMLElement;
		const form = logoutButton.closest('form') as HTMLFormElement;

		// jsdom/browser-mode test env never actually navigates on a real form submission, so we
		// intercept the native 'submit' event to prove a real submission fires — not merely that a
		// click handler ran. preventDefault() stops the browser from attempting real navigation.
		const submitHandler = vi.fn((event: SubmitEvent) => event.preventDefault());
		form.addEventListener('submit', submitHandler);

		logoutButton.focus();
		expect(document.activeElement).toBe(logoutButton);

		await userEvent.keyboard('{Enter}');

		expect(submitHandler).toHaveBeenCalledTimes(1);
	});

	it('reflects the DropdownMenu wrapper open state back to the trigger (bind:open two-way through the wrapper)', async () => {
		render(AccountMenu, { email: 'sophie.martin@gmail.com', isAdmin: false });

		const trigger = page.getByRole('button', { name: 'Menu du compte' });
		await expect.element(trigger).toHaveAttribute('aria-expanded', 'false');

		await userEvent.click(trigger);

		// AccountMenu's local `open` state var (bound two-way through the DropdownMenu wrapper)
		// drives the avatar's active styling — proves the wrapper's bindable `open` prop actually
		// propagates changes from bits-ui's internal state back up to the consumer, not just down.
		await expect.element(trigger).toHaveAttribute('aria-expanded', 'true');
		const avatar = trigger.element().querySelector('div[aria-hidden="true"]');
		expect(avatar?.className ?? '').toContain('bg-zinc-200');
	});
});
