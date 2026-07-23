import { page, userEvent } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import EmptyState from './EmptyState.svelte';

function iconSnippet() {
	return createRawSnippet(() => ({
		render: () => '<svg aria-hidden="true"><path /></svg>'
	}));
}

describe('EmptyState.svelte', () => {
	it('renders the title and description text', async () => {
		render(EmptyState, {
			title: 'Aucune transaction',
			description: 'Importez un relevé pour commencer.'
		});

		await expect.element(page.getByText('Aucune transaction')).toBeInTheDocument();
		await expect.element(page.getByText('Importez un relevé pour commencer.')).toBeInTheDocument();
	});

	it('renders the icon snippet when card is true (default)', async () => {
		const { container } = render(EmptyState, {
			title: 'Vide',
			icon: iconSnippet()
		});

		expect(container.querySelector('svg')).not.toBeNull();
	});

	it('wraps content in the solid card classes by default', async () => {
		const { container } = render(EmptyState, { title: 'Vide', icon: iconSnippet() });

		const wrapper = container.querySelector('div')!;
		expect(wrapper.className).toContain('px-6');
		expect(wrapper.className).toContain('py-16');
	});

	it('renders without card wrapper classes when card=false', async () => {
		const { container } = render(EmptyState, { title: 'Vide', card: false });

		const wrapper = container.querySelector('div')!;
		expect(wrapper.className).not.toContain('px-6');
		expect(wrapper.className).not.toContain('py-16');
		expect(wrapper.className).toContain('py-12');
	});

	it('does not force an icon when card=false and none is passed', async () => {
		const { container } = render(EmptyState, { title: 'Vide', card: false });

		expect(container.querySelector('svg')).toBeNull();
		expect(container.querySelector('.rounded-full')).toBeNull();
	});

	it('still renders a passed icon even when card=false', async () => {
		const { container } = render(EmptyState, { title: 'Vide', card: false, icon: iconSnippet() });

		expect(container.querySelector('svg')).not.toBeNull();
	});

	it('renders a primary CTA button and fires onCtaClick when clicked', async () => {
		const onCtaClick = vi.fn();
		render(EmptyState, {
			title: 'Vide',
			ctaLabel: 'Importer',
			onCtaClick
		});

		await userEvent.click(page.getByRole('button', { name: 'Importer' }));

		expect(onCtaClick).toHaveBeenCalledTimes(1);
	});

	it('renders the primary CTA as a link when ctaHref is given, not a button', async () => {
		const { container } = render(EmptyState, {
			title: 'Vide',
			ctaLabel: 'Aller aux réglages',
			ctaHref: '/settings'
		});

		const link = page.getByRole('link', { name: 'Aller aux réglages' }).element();
		expect(link.getAttribute('href')).toBe('/settings');
		expect(container.querySelector('button')).toBeNull();
	});

	it('renders the action snippet instead of ctaLabel when both are provided', async () => {
		const onCtaClick = vi.fn();
		const actionSnippet = createRawSnippet(() => ({
			render: () => '<button type="button">Action personnalisée</button>'
		}));
		render(EmptyState, {
			title: 'Vide',
			action: actionSnippet,
			ctaLabel: 'Ignoré',
			onCtaClick
		});

		await expect
			.element(page.getByRole('button', { name: 'Action personnalisée' }))
			.toBeInTheDocument();
		expect(page.getByRole('button', { name: 'Ignoré' }).elements().length).toBe(0);
	});

	it('renders a secondary CTA as a TapLink only when both secondaryLabel and onSecondaryClick are passed', async () => {
		const onSecondaryClick = vi.fn();
		render(EmptyState, {
			title: 'Vide',
			secondaryLabel: 'Ajouter manuellement',
			onSecondaryClick
		});

		const secondary = page.getByRole('button', { name: /Ajouter manuellement/ });
		await userEvent.click(secondary);

		expect(onSecondaryClick).toHaveBeenCalledTimes(1);
	});

	it('does not render a secondary CTA when secondaryLabel is missing', async () => {
		render(EmptyState, { title: 'Vide', onSecondaryClick: vi.fn() });

		expect(page.getByRole('button').elements().length).toBe(0);
	});

	it('does not render a secondary CTA when onSecondaryClick is missing', async () => {
		render(EmptyState, { title: 'Vide', secondaryLabel: 'Ajouter manuellement' });

		expect(page.getByText('Ajouter manuellement').elements().length).toBe(0);
	});

	it('renders cleanly with only icon/title/description and no CTA at all', async () => {
		const { container } = render(EmptyState, {
			title: 'Rien à afficher',
			description: 'Tout est vide ici.',
			icon: iconSnippet()
		});

		await expect.element(page.getByText('Rien à afficher')).toBeInTheDocument();
		await expect.element(page.getByText('Tout est vide ici.')).toBeInTheDocument();
		expect(container.querySelector('button, a')).toBeNull();
	});
});
