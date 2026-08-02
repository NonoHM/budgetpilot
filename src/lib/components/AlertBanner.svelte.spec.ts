import { page, userEvent } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import AlertBanner from './AlertBanner.svelte';

function textSnippet(text: string) {
	return createRawSnippet(() => ({
		render: () => `<span>${text}</span>`
	}));
}

describe('AlertBanner.svelte', () => {
	it('auto-hides a success banner after autoDismissMs', async () => {
		render(AlertBanner, { variant: 'success', autoDismissMs: 20, children: textSnippet('OK') });

		await expect.element(page.getByText('OK')).toBeInTheDocument();
		await expect.poll(() => page.getByText('OK').elements().length).toBe(0);
	});

	it('never auto-hides an error banner regardless of autoDismissMs', async () => {
		render(AlertBanner, { variant: 'error', autoDismissMs: 20, children: textSnippet('Oops') });

		await new Promise((resolve) => setTimeout(resolve, 100));
		await expect.element(page.getByText('Oops')).toBeInTheDocument();
	});

	it('never auto-hides a warning banner regardless of autoDismissMs', async () => {
		render(AlertBanner, {
			variant: 'warning',
			autoDismissMs: 20,
			children: textSnippet('Careful')
		});

		await new Promise((resolve) => setTimeout(resolve, 100));
		await expect.element(page.getByText('Careful')).toBeInTheDocument();
	});

	it('closes any variant immediately via the manual close button', async () => {
		render(AlertBanner, { variant: 'error', children: textSnippet('Oops') });

		await userEvent.click(page.getByRole('button', { name: 'Fermer' }));

		await expect.poll(() => page.getByText('Oops').elements().length).toBe(0);
	});

	it('lets the user dismiss a success banner early, before the timer fires', async () => {
		render(AlertBanner, { variant: 'success', autoDismissMs: 5000, children: textSnippet('OK') });

		await userEvent.click(page.getByRole('button', { name: 'Fermer' }));

		await expect.poll(() => page.getByText('OK').elements().length).toBe(0);
	});

	it('renders an action snippet that is clickable and does not replace the close button', async () => {
		const onUndo = () => {
			undone = true;
		};
		let undone = false;
		const actionSnippet = createRawSnippet(() => ({
			render: () => '<button type="button">Annuler</button>',
			setup: (node) => {
				node.addEventListener('click', onUndo);
			}
		}));
		render(AlertBanner, {
			variant: 'warning',
			children: textSnippet('Careful'),
			action: actionSnippet
		});

		await userEvent.click(page.getByRole('button', { name: 'Annuler' }));
		expect(undone).toBe(true);

		await expect.element(page.getByRole('button', { name: 'Fermer' })).toBeInTheDocument();
	});

	it('still auto-dismisses a success banner when an action snippet is present', async () => {
		const actionSnippet = createRawSnippet(() => ({
			render: () => '<button type="button">Annuler</button>'
		}));
		render(AlertBanner, {
			variant: 'success',
			autoDismissMs: 20,
			children: textSnippet('OK'),
			action: actionSnippet
		});

		await expect.element(page.getByText('OK')).toBeInTheDocument();
		await expect.poll(() => page.getByText('OK').elements().length).toBe(0);
	});

	it('places the action between the message and the close control, never after it', async () => {
		// The transverse-tags design calls for exactly this order (message -> action -> close) for
		// its bulk-apply undo banner: right-aligned, but still before dismiss. Order is asserted
		// via DOM position rather than just presence, so a future refactor that appends the action
		// after "Fermer" is caught.
		const actionSnippet = createRawSnippet(() => ({
			render: () => '<button type="button">Annuler</button>'
		}));
		const { container } = render(AlertBanner, {
			variant: 'warning',
			children: textSnippet('Careful'),
			action: actionSnippet
		});

		const buttons = Array.from(container.querySelectorAll('button')).map(
			(b) => b.getAttribute('aria-label') ?? b.textContent?.trim()
		);
		expect(buttons).toEqual(['Annuler', 'Fermer']);
	});

	it('has no action at all when the caller passes none, so existing callers are unaffected', async () => {
		render(AlertBanner, { variant: 'error', children: textSnippet('Oops') });

		expect(page.getByRole('button').elements().length).toBe(1);
		await expect.element(page.getByRole('button', { name: 'Fermer' })).toBeInTheDocument();
	});
});
