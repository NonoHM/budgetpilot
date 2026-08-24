import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import AccountMenu from './AccountMenu.svelte';

/**
 * OPENS THE MENU AND WAITS FOR IT TO BE OPEN, which are two things.
 *
 * #241: the logout test failed intermittently in CI with `expected "vi.fn()" to be called 1 times,
 * but got 0 times`. The element was there and the key landed on it and nothing submitted, so what
 * was missing was not the element but the handler behind it: `userEvent.click` resolves when the
 * click is dispatched, not when bits-ui has finished wiring the menu it opens.
 *
 * `expect.element` RETRIES, which is what makes this a wait rather than an earlier assertion. That
 * was measured while fixing the TagPicker sites: a probe asserting against a value that arrived
 * 300 ms late passed, and went red when the late arrival was removed.
 *
 * A `waitForTimeout` is refused by standing decision. It widens the race instead of removing it,
 * and the next reader of a red run would have no way to separate a slow machine from a broken menu.
 *
 * Every site goes through here, including the four that already gated themselves by asserting with
 * `expect.element` on something inside the menu. Those were correct by accident of what they
 * asserted next, and an accident is not a precondition.
 */
async function openMenu() {
	const trigger = page.getByRole('button', { name: 'Menu du compte' });
	await userEvent.click(trigger);
	await expect.element(trigger).toHaveAttribute('aria-expanded', 'true');
	return trigger;
}

describe('AccountMenu.svelte', () => {
	it('cache le lien Administration pour un utilisateur non admin', async () => {
		render(AccountMenu, { email: 'sophie.martin@gmail.com', isAdmin: false });

		await openMenu();

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

		await openMenu();

		await expect
			.element(page.getByRole('menuitem', { name: 'Administration' }))
			.toHaveAttribute('href', '/admin');
		await expect
			.element(page.getByRole('menuitem', { name: 'Paramètres' }))
			.toHaveAttribute('href', '/settings');
	});

	it('place le bouton de déconnexion dans un formulaire POST vers /logout', async () => {
		render(AccountMenu, { email: 'sophie.martin@gmail.com', isAdmin: false });

		await openMenu();

		const logoutButton = page.getByRole('menuitem', { name: 'Déconnexion' });
		await expect.element(logoutButton).toBeInTheDocument();

		const form = document.querySelector('form[action="/logout"]');
		expect(form).not.toBeNull();
		expect(form?.getAttribute('method')).toBe('POST');
	});

	it('renders the logout menu item as a real <button type="submit"> inside a real <form>, not a link or a div', async () => {
		render(AccountMenu, { email: 'sophie.martin@gmail.com', isAdmin: false });

		await openMenu();

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

		await openMenu();

		const logoutItem = page.getByRole('menuitem', { name: 'Déconnexion' });
		const logoutButton = logoutItem.element() as HTMLElement;
		const form = logoutButton.closest('form') as HTMLFormElement;

		// The browser-mode test env never actually navigates on a real form submission, so we
		// intercept the native 'submit' event to prove a real submission fires — not merely that a
		// click handler ran. preventDefault() stops the browser from attempting real navigation.
		const submitHandler = vi.fn((event: SubmitEvent) => event.preventDefault());
		form.addEventListener('submit', submitHandler);

		logoutButton.focus();
		expect(document.activeElement).toBe(logoutButton);

		// Element-targeted (userEvent.type -> Playwright's locator.press), never page-level
		// userEvent.keyboard(). keyboard() dispatches at the page/window level, so it lands on
		// whatever the OS considers focused rather than the element .focus()'d via JS — with
		// several browser-mode files running concurrently in CI that races for real window focus
		// and sends Enter nowhere. press() focuses the located element itself before keying, so
		// the outcome no longer depends on window focus at all. Focus is asserted before the
		// press, not after: submitting closes the menu and bits-ui moves focus on the way out.
		await userEvent.type(logoutItem, '{Enter}');

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
