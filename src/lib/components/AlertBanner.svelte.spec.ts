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
});
