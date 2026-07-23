import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { ActionData, PageData } from './$types';

// Verifies the page-level/modal AlertBanner gating introduced for form.error and form.success
// on /budgets (src/routes/budgets/+page.svelte): budgets previously had ZERO post-action
// feedback, and now reuses a single generic `form.error` key for both a page-level banner and
// each modal's own contextual banner. Without gating (`!showCreateModal && !editingBudget &&
// !deletingBudget`), opening a modal with a form error would render the SAME message twice via
// two role="alert" elements — this suite proves exactly one is ever rendered.

function baseData(overrides: Partial<PageData> = {}): PageData {
	return {
		budgets: [],
		categoryOptions: ['Alimentation'],
		categories: [{ name: 'Alimentation', defaultKey: null }],
		currentMonth: '2026-07',
		...overrides
	} as PageData;
}

describe('/budgets AlertBanner gating', () => {
	it('shows the page-level error banner when no modal is open', async () => {
		const screen = render(Page, {
			data: baseData(),
			form: { error: 'Boom' } as unknown as ActionData
		});

		const alerts = document.querySelectorAll('[role="alert"]');
		expect(alerts.length).toBe(1);
		await expect.element(screen.getByText('Boom')).toBeInTheDocument();
	});

	it('renders exactly one role="alert" (not two) while the create modal is open with a form error', async () => {
		const screen = render(Page, {
			data: baseData({ budgets: [] }),
			form: { error: 'Category is required' } as unknown as ActionData
		});

		// Open the create modal via the empty-state CTA (data.budgets is empty).
		await screen.getByText('Créer mon premier budget').click();

		const alerts = document.querySelectorAll('[role="alert"]');
		expect(alerts.length).toBe(1);
	});

	it('renders exactly one role="alert" while the delete ConfirmDialog is open with a form error', async () => {
		const screen = render(Page, {
			data: baseData({
				budgets: [
					{
						id: 'b1',
						categoryName: 'Alimentation',
						amountCents: 25000,
						amountEuros: '250,00',
						spentCents: 1000,
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
			form: { success: 'Budget créé' } as unknown as ActionData
		});

		const statuses = document.querySelectorAll('[role="status"]');
		expect(statuses.length).toBe(1);
		await expect.element(screen.getByText('Budget créé')).toBeInTheDocument();
	});

	it('renders no alert/status banner when form is null', async () => {
		render(Page, { data: baseData(), form: null });

		expect(document.querySelectorAll('[role="alert"]').length).toBe(0);
		expect(document.querySelectorAll('[role="status"]').length).toBe(0);
	});
});
