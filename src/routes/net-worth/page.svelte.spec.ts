import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { ActionData, PageData } from './$types';

// Verifies the AlertBanner gating on /net-worth (src/routes/net-worth/+page.svelte). This page
// ALREADY had a page-level form.error banner before this change — the highest-risk case, since
// a regression here means an existing, previously-correct banner starts double-rendering
// alongside the newly-converted modal banners. Same generic `form.error` key is reused by the
// page-level banner and by each modal's own contextual banner; gating
// (`!showCreateModal && !editingAccount && !deletingAccount`) must keep exactly one
// role="alert" visible at a time.

function baseData(overrides: Partial<PageData> = {}): PageData {
	return {
		accounts: [],
		series: [],
		manualAccountNetWorthAccountId: null,
		savingsGoals: [],
		linkableAccounts: [],
		...overrides
	} as PageData;
}

describe('/net-worth AlertBanner gating', () => {
	it('shows the page-level error banner when no modal is open', async () => {
		const screen = render(Page, {
			data: baseData(),
			form: { error: 'Boom' } as unknown as ActionData
		});

		const alerts = document.querySelectorAll('[role="alert"]');
		expect(alerts.length).toBe(1);
		await expect.element(screen.getByText('Boom')).toBeInTheDocument();
	});

	it('renders exactly one role="alert" while the create modal is open with a form error', async () => {
		const screen = render(Page, {
			data: baseData({ accounts: [] }),
			form: { error: 'Name is required' } as unknown as ActionData
		});

		// Open the create modal via the empty-state CTA (data.accounts is empty).
		await screen.getByText('Ajouter mon premier compte').click();

		const alerts = document.querySelectorAll('[role="alert"]');
		expect(alerts.length).toBe(1);
	});

	it('renders exactly one role="alert" while the edit modal is open with a form error', async () => {
		const screen = render(Page, {
			data: baseData({
				accounts: [
					{
						id: 'a1',
						name: 'Livret A',
						type: 'savings',
						balanceCents: 500000,
						balanceEuros: '5000,00',
						connected: false,
						createdAt: '2026-07-01T00:00:00.000Z',
						updatedAt: '2026-07-01T00:00:00.000Z'
					}
				]
			}),
			form: { error: 'Update failed' } as unknown as ActionData
		});

		const editButtons = screen.container.querySelectorAll('button[aria-label*="Modifier"]');
		expect(editButtons.length).toBeGreaterThan(0);
		(editButtons[0] as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		const alerts = document.querySelectorAll('[role="alert"]');
		expect(alerts.length).toBe(1);
	});

	it('renders exactly one role="alert" while the delete ConfirmDialog is open with a form error', async () => {
		const screen = render(Page, {
			data: baseData({
				accounts: [
					{
						id: 'a1',
						name: 'Livret A',
						type: 'savings',
						balanceCents: 500000,
						balanceEuros: '5000,00',
						connected: false,
						createdAt: '2026-07-01T00:00:00.000Z',
						updatedAt: '2026-07-01T00:00:00.000Z'
					}
				]
			}),
			form: { error: 'Delete failed' } as unknown as ActionData
		});

		const deleteButtons = screen.container.querySelectorAll('button[aria-label*="Supprimer"]');
		expect(deleteButtons.length).toBeGreaterThan(0);
		(deleteButtons[0] as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		const alerts = document.querySelectorAll('[role="alert"]');
		expect(alerts.length).toBe(1);
	});

	it('shows the success banner with the server-provided text after a successful action', async () => {
		const screen = render(Page, {
			data: baseData(),
			form: { success: 'Compte créé' } as unknown as ActionData
		});

		const statuses = document.querySelectorAll('[role="status"]');
		expect(statuses.length).toBe(1);
		await expect.element(screen.getByText('Compte créé')).toBeInTheDocument();
	});

	it('renders no alert/status banner when form is null', async () => {
		render(Page, { data: baseData(), form: null });

		expect(document.querySelectorAll('[role="alert"]').length).toBe(0);
		expect(document.querySelectorAll('[role="status"]').length).toBe(0);
	});
});
