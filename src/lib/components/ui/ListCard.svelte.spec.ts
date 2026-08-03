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

	it('announces the active card, not only tints it', async () => {
		expect.assertions(2);
		const { container } = render(ListCard, {
			children: rawSnippet('<span>Row content</span>'),
			href: '/transactions?selected=tx-1',
			active: true
		});

		// The tint alone shipped first, so the desktop table announced its selected row while the
		// mobile list said nothing at all. Both halves are asserted here, on one component, so a
		// future change cannot keep the visual and drop the semantic.
		expect(container.querySelector('a')?.getAttribute('aria-current')).toBe('true');
		expect(container.querySelector('div')?.className).toContain('bg-zinc-50');
	});

	it('leaves an inactive card unannounced', async () => {
		expect.assertions(1);
		const { container } = render(ListCard, {
			children: rawSnippet('<span>Row content</span>'),
			href: '/transactions?selected=tx-2'
		});

		// Absent, not `aria-current="false"`: the attribute would then be on every row in the list,
		// and a screen reader reading a list of thirty "not current" rows is worse than silence.
		expect(container.querySelector('a')?.getAttribute('aria-current')).toBeNull();
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
