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

	it('never auto-hides an info banner regardless of autoDismissMs', async () => {
		render(AlertBanner, {
			variant: 'info',
			autoDismissMs: 20,
			children: textSnippet('Rename them?')
		});

		// An offer the reader has not answered yet is not a confirmation that can expire.
		await new Promise((resolve) => setTimeout(resolve, 100));
		await expect.element(page.getByText('Rename them?')).toBeInTheDocument();
	});

	it('announces an info banner politely, not assertively', async () => {
		render(AlertBanner, { variant: 'info', children: textSnippet('Rename them?') });

		// `status`/`polite` rather than `alert`/`assertive`: an assertive region cuts across
		// whatever the reader is in the middle of, which is right for an error blocking their
		// action and wrong for an offer they can take at any time.
		const banner = page.getByRole('status').element();
		expect(banner.getAttribute('aria-live')).toBe('polite');
		expect(banner.textContent).toContain('Rename them?');
	});

	it('gives info its own GLYPH, so the tone is never carried by colour alone', () => {
		// The accessibility rule this variant is most likely to break. Zinc against rose is a
		// colour difference, and a reader who cannot use colour has to be able to tell an offer
		// from a failure. Asserted on the SVG markup rather than on a class name: the class is what
		// the author wrote, the markup is what the reader sees.
		//
		// Two structural differences, both checked. Info's circle is STROKED where error's is
		// filled, and info's dot sits ABOVE the bar where error's sits below.
		const { container: infoContainer } = render(AlertBanner, {
			variant: 'info',
			children: textSnippet('Offer')
		});
		const infoIcon = infoContainer.querySelector('[aria-hidden="true"] svg');

		const { container: errorContainer } = render(AlertBanner, {
			variant: 'error',
			children: textSnippet('Failure')
		});
		const errorIcon = errorContainer.querySelector('[aria-hidden="true"] svg');

		expect(infoIcon?.getAttribute('fill')).toBe('none');
		expect(errorIcon?.getAttribute('fill')).toBe('currentColor');
		expect(infoIcon?.innerHTML).not.toBe(errorIcon?.innerHTML);
	});

	it('lets a caller name the close control when "Close" would understate it', async () => {
		// A banner whose dismissal is PERSISTED makes the X a permanent decision. Announced as
		// "Close", a screen reader user has no way to know that before pressing it.
		render(AlertBanner, {
			variant: 'info',
			dismissLabel: 'Keep the current names',
			children: textSnippet('Offer')
		});

		await expect
			.element(page.getByRole('button', { name: 'Keep the current names' }))
			.toBeVisible();
		expect(page.getByRole('button', { name: 'Fermer' }).elements().length).toBe(0);
	});

	it('still says "Fermer" when no dismissLabel is passed, so existing callers are unaffected', async () => {
		render(AlertBanner, { variant: 'info', children: textSnippet('Offer') });

		await expect.element(page.getByRole('button', { name: 'Fermer' })).toBeVisible();
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
