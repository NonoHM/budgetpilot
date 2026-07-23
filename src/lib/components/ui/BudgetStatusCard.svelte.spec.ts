import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import BudgetStatusCard from './BudgetStatusCard.svelte';

describe('BudgetStatusCard.svelte', () => {
	it('hides the status badge by default when variant is plain', async () => {
		render(BudgetStatusCard, {
			categoryLabel: 'Alimentation',
			spentCents: 1000,
			limitCents: 25000,
			variant: 'plain'
		});

		await expect.element(page.getByText('Alimentation')).toBeInTheDocument();
		expect(page.getByText('OK', { exact: true }).elements().length).toBe(0);
	});

	it('shows the status badge when variant is plain but showBadge is explicitly set', async () => {
		render(BudgetStatusCard, {
			categoryLabel: 'Alimentation',
			spentCents: 1000,
			limitCents: 25000,
			variant: 'plain',
			showBadge: true
		});

		await expect.element(page.getByText('OK', { exact: true })).toBeInTheDocument();
	});

	it('shows the status badge by default when variant is card', async () => {
		render(BudgetStatusCard, {
			categoryLabel: 'Alimentation',
			spentCents: 1000,
			limitCents: 25000
		});

		await expect.element(page.getByText('OK', { exact: true })).toBeInTheDocument();
	});
});
