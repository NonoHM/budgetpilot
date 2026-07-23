import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import PageSpinner from './PageSpinner.svelte';

describe('PageSpinner.svelte', () => {
	it('exposes a role="status" region with an accessible label', async () => {
		render(PageSpinner, { label: 'Chargement…' });

		await expect.element(page.getByRole('status')).toBeInTheDocument();
		await expect.element(page.getByText('Chargement…')).toBeInTheDocument();
	});

	it('renders a 28px decorative spinner icon', async () => {
		const { container } = render(PageSpinner, { label: 'Chargement…' });

		const svg = container.querySelector('svg') as SVGElement;
		expect(svg.getAttribute('aria-hidden')).toBe('true');
		expect(svg.style.width).toBe('28px');
	});
});
