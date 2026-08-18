import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../routes/layout.css';
import Button from './Button.svelte';
import ConfirmDialog from './ConfirmDialog.svelte';

/**
 * Planche 5f: a modal owns its action until the answer, and the return appears on the surface that
 * was pressed.
 *
 * ## What was measured before this, in a real browser
 *
 * The plate states that today a refused delete closes the dialog and leaves the row. That is NOT
 * the mechanism: `/imports` clears its pending state only on a redirect and already renders an
 * error banner inside the dialog. What IS live, and reaches the same outcome by another route,
 * was probed and is what these tests pin:
 *
 *   escape-closes=1        Escape closes the dialog while the request is in flight
 *   backdrop-closes=1      a backdrop click does the same
 *   nativeDisabled=true    the confirm carries the native attribute, so it leaves the tab order
 *                          at the exact moment the user is waiting for an answer where they pressed
 *   text="En cours…"       a generic fallback rather than the action's own verb
 *
 * An escape mid-flight is the plate's defect exactly: the answer arrives in a screen that no longer
 * exists, the row is still there, and it reads as a press that did nothing.
 */
function body() {
	return createRawSnippet(() => ({ render: () => '<p>Ses 25 transactions seront retirées.</p>' }));
}

describe('a button that is occupied rather than disabled', () => {
	// THE DISTINCTION, and it is the one the plate forbids by name. `disabled` removes the element
	// from the tab order and sends focus to the body at the precise moment the user is waiting for an
	// answer at the place they pressed.
	it('keeps its focus and its name, and refuses activation without going disabled', async () => {
		const onclick = vi.fn();
		const screen = render(Button, {
			loading: true,
			busyLabel: 'Suppression…',
			onclick,
			children: createRawSnippet(() => ({ render: () => '<span>Supprimer</span>' }))
		});
		const button = (await screen.getByRole('button').element()) as HTMLButtonElement;

		expect(button.hasAttribute('disabled')).toBe(false);
		expect(button.getAttribute('aria-busy')).toBe('true');
		button.focus();
		expect(document.activeElement).toBe(button);

		button.click();
		expect(onclick).not.toHaveBeenCalled();
	});

	// The VERB, visible. « En cours… » is a fallback that says nothing about what is running; the
	// action's own verb in the progressive is the same action, in its course.
	it('shows the verb rather than a bare spinner', async () => {
		const screen = render(Button, {
			loading: true,
			busyLabel: 'Suppression…',
			children: createRawSnippet(() => ({ render: () => '<span>Supprimer</span>' }))
		});

		await expect.element(screen.getByText('Suppression…')).toBeInTheDocument();
	});

	// The width is frozen at the resting measurement, so the footer does not reorganise under the
	// finger. Measured as a comparison between the two states rather than as a figure, because the
	// figure depends on the font and the label.
	it('does not change width when it becomes busy', async () => {
		const screen = render(Button, {
			children: createRawSnippet(() => ({ render: () => '<span>Supprimer</span>' }))
		});
		const button = (await screen.getByRole('button').element()) as HTMLButtonElement;
		const resting = button.getBoundingClientRect().width;

		await screen.rerender({ loading: true, busyLabel: 'Suppression…' });

		expect(button.getBoundingClientRect().width).toBe(resting);
	});
});

describe('a confirmation that owns its action until the answer', () => {
	// PROBED AS FAILING BEFORE THIS, and it is the plate's defect reached by another route: the
	// answer lands in a screen that no longer exists.
	it('does not close on Escape while the request is in flight', async () => {
		const onClose = vi.fn();
		render(ConfirmDialog, {
			open: true,
			title: 'Supprimer ?',
			phase: 'busy',
			onClose,
			children: body()
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

		expect(onClose).not.toHaveBeenCalled();
	});

	it('does not close on a backdrop click while the request is in flight', async () => {
		const onClose = vi.fn();
		render(ConfirmDialog, {
			open: true,
			title: 'Supprimer ?',
			phase: 'busy',
			onClose,
			children: body()
		});

		(document.querySelector('[role="presentation"]') as HTMLElement).dispatchEvent(
			new MouseEvent('click', { bubbles: true })
		);

		expect(onClose).not.toHaveBeenCalled();
	});

	// Escape still closes an IDLE dialog. Asserted beside the two above, because a repair that
	// neutralised Escape unconditionally would pass both of them and break every other dialog.
	it('still closes on Escape when nothing is in flight', async () => {
		const onClose = vi.fn();
		render(ConfirmDialog, { open: true, title: 'Supprimer ?', onClose, children: body() });

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	// The failure appears BETWEEN the body and the actions, carries role="alert", and TAKES FOCUS.
	// The role alone announces it; the focus is what puts the reader at the thing that changed, and
	// they fail for different reasons so both are asserted.
	it('renders the failure between the body and the actions, and moves focus onto it', async () => {
		// THE REAL TRANSITION, and the fixture matters: a dialog that OPENS already failed does not
		// occur, and mounting one produces a focus ordering that does not either. The modal focuses
		// its own content when it opens, which is a parent effect and therefore runs after any child's
		// on the same mount. In the journey the dialog opens idle, the request goes out, and the
		// failure arrives afterwards, which is what this drives.
		const screen = render(ConfirmDialog, {
			open: true,
			title: 'Supprimer ?',
			onClose: () => {},
			children: body()
		});
		await screen.rerender({
			phase: 'error',
			error: {
				message: 'La suppression a échoué. Rien n’a été retiré. Réessayez.',
				actionLabel: 'Réessayer',
				onAction: () => {}
			}
		});

		const alert = document.querySelector('[role="alert"]') as HTMLElement;
		expect(alert).not.toBeNull();
		expect(alert.textContent).toContain('Rien');
		await new Promise((r) => queueMicrotask(() => r(null)));
		expect(document.activeElement).toBe(alert);

		// BETWEEN the body and the actions, asserted by DOM order against the two elements it sits
		// between rather than against the dialog. The FIRST `<button>` in this dialog is the modal's
		// own close control and not the confirm, so the comparison takes the last one: getting that
		// wrong is what made the first version of this assertion compare the banner against the ✕.
		const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
		const nodes = [...dialog.querySelectorAll('*')];
		const bodyText = [...dialog.querySelectorAll('p')].find((p) =>
			p.textContent?.includes('seront retirées')
		)!;
		const confirm = [...dialog.querySelectorAll('button')].at(-1)!;
		expect(nodes.indexOf(alert)).toBeGreaterThan(nodes.indexOf(bodyText));
		expect(nodes.indexOf(alert)).toBeLessThan(nodes.indexOf(confirm));
	});

	// THE RULE OF THIS SECTION, and the plate says a test that closes the modal on the press locks
	// the defect in. The dialog is still mounted with the failure showing.
	it('is still mounted after a failure, with the action re-offered', async () => {
		const onAction = vi.fn();
		render(ConfirmDialog, {
			open: true,
			title: 'Supprimer ?',
			phase: 'error',
			error: { message: 'La suppression a échoué.', actionLabel: 'Réessayer', onAction },
			onClose: () => {},
			children: body()
		});

		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		const retry = [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
			b.textContent?.includes('Réessayer')
		) as HTMLElement;
		expect(retry).toBeTruthy();
		retry.click();
		expect(onAction).toHaveBeenCalledTimes(1);
	});

	// The two failure classes are told apart by their BUTTON, not only by their sentence: retrying an
	// irreversible action blind is the worst advice a banner can give, so a no-answer offers a
	// refresh instead.
	it('offers a refresh rather than a retry when there was no answer at all', async () => {
		render(ConfirmDialog, {
			open: true,
			title: 'Supprimer ?',
			phase: 'error',
			error: {
				message: 'Nous n’avons pas reçu de réponse. Actualisez la liste avant de réessayer.',
				actionLabel: 'Actualiser la liste',
				onAction: () => {}
			},
			onClose: () => {},
			children: body()
		});

		const labels = [...document.querySelectorAll('[role="dialog"] button')].map((b) =>
			b.textContent?.trim()
		);
		expect(labels).toContain('Actualiser la liste');
		expect(labels).not.toContain('Réessayer');
	});
});
