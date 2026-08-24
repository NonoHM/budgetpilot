import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import AccountMenu from './AccountMenu.svelte';

/**
 * OPENS THE MENU AND WAITS FOR IT TO BE OPEN, which are two things.
 *
 * `expect.element` RETRIES, which is what makes this a wait rather than an earlier assertion. That
 * was measured while fixing the TagPicker sites: a probe asserting against a value that arrived
 * 300 ms late passed, and went red when the late arrival was removed.
 *
 * Every site goes through here, including the four that already gated themselves by asserting with
 * `expect.element` on something inside the menu. Those were correct by accident of what they
 * asserted next, and an accident is not a precondition.
 *
 * WHAT THIS GATE DOES NOT DO IS CLOSE #241, AND IT USED TO SAY IT DID. `aria-expanded` flips with
 * the open state, which is strictly before bits-ui moves focus, so this waits for the menu to
 * exist and says nothing about where focus is. The logout test below carries the measurement and
 * the gate that actually separates the two states.
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

		// #241, AND THE PRECONDITION IS OBSERVED WHERE IT MATTERS RATHER THAN BEFORE IT MATTERS.
		//
		// Measured 2026-08-24 with in-process draws, because whole-suite repetition cannot sample
		// this: solo, 0 misses in 100 draws; under 8 concurrent browser-mode files, 3 misses in
		// 480. Every failing draw carried the identical chain, with the gate above already passed:
		//
		//   66ms bits-ui focuses the menu content   69ms the gate reads aria-expanded=true
		//   69ms this test focuses the logout button
		//   80ms bits-ui focuses the menu content AGAIN
		//   82ms Enter is delivered to div[role=menu], never to the button
		//
		// bits-ui's FocusScope defers its open auto-focus into a requestAnimationFrame and
		// schedules it TWICE per open (bits-ui `#handleOpenAutoFocus`). The item's keydown handler
		// is what submits, by calling `currentTarget.click()`, so a key delivered to the menu
		// container submits nothing and reports `called 0 times`.
		//
		// The provider is the other half: `userEvent.type` is `locator.focus()` followed by a
		// PAGE-LEVEL `keyboard.down`, two round trips apart, and the second rAF fits between them.
		// The comment that used to sit here said press() focuses the element and the outcome no
		// longer depends on focus; the first clause is true of `locator.press`, which this is not.
		//
		// So no gate placed before the press can close it, and a `waitForTimeout` is refused by
		// standing decision anyway. What separates the two states is observing where the key
		// LANDED. Retaking focus is conditional on having observed it land elsewhere, which is why
		// this is not a blind retry: a component that stops submitting keeps the key and fails the
		// second assertion, and a harness that can never deliver it fails the first by name.
		let keyReachedButton = false;
		logoutButton.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') keyReachedButton = true;
		});

		for (let attempt = 0; attempt < 10 && !keyReachedButton; attempt++) {
			logoutButton.focus();
			await userEvent.type(logoutItem, '{Enter}');
		}

		// Separates "the key never reached the button" from "it did and nothing submitted". The
		// pre-press `expect(document.activeElement).toBe(logoutButton)` that used to stand here
		// separated neither: it read LOGOUT on all 480 draws, the 3 failing ones included.
		expect(keyReachedButton, 'Enter never reached the logout button in 10 attempts').toBe(true);
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
