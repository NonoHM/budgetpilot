import { page, userEvent } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ListCard from './ListCard.svelte';

function rawSnippet(html: string) {
	return createRawSnippet(() => ({ render: () => html }));
}

describe('ListCard.svelte', () => {
	it('toggles the expand button aria-label between show/hide details when no expandLabel is passed', async () => {
		render(ListCard, {
			children: rawSnippet('<span>Row content</span>'),
			details: rawSnippet('<span>Details content</span>')
		});

		const toggle = page.getByRole('button', { name: 'Afficher les détails' });
		await expect.element(toggle).toBeInTheDocument();

		await userEvent.click(toggle);

		await expect
			.element(page.getByRole('button', { name: 'Masquer les détails' }))
			.toBeInTheDocument();
	});

	it('uses the provided expandLabel as a fixed aria-label instead of the default toggle', async () => {
		render(ListCard, {
			children: rawSnippet('<span>Row content</span>'),
			details: rawSnippet('<span>Details content</span>'),
			expandLabel: 'Supprimer'
		});

		await expect.element(page.getByRole('button', { name: 'Supprimer' })).toBeInTheDocument();
	});

	it('uses expandAriaLabel for the accessible name while keeping the default visible glyph', async () => {
		render(ListCard, {
			children: rawSnippet('<span>Row content</span>'),
			details: rawSnippet('<span>Details content</span>'),
			expandAriaLabel: 'Supprimer la règle Coinbase'
		});

		const toggle = page.getByRole('button', { name: 'Supprimer la règle Coinbase' });
		await expect.element(toggle).toBeInTheDocument();
		await expect.element(toggle).toHaveTextContent('···');
	});

	it('prefers expandAriaLabel over expandLabel for the accessible name when both are passed', async () => {
		render(ListCard, {
			children: rawSnippet('<span>Row content</span>'),
			details: rawSnippet('<span>Details content</span>'),
			expandLabel: 'Actions',
			expandAriaLabel: 'Supprimer la règle Coinbase'
		});

		await expect
			.element(page.getByRole('button', { name: 'Supprimer la règle Coinbase' }))
			.toHaveTextContent('Actions');
	});
});
