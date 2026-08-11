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
		categories: [{ name: 'Alimentation' }],
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

/**
 * The other half of the wrong-month defect: this is what the month KEY becomes on screen.
 *
 * `getCurrentMonth()` produces the key and is asserted directly, under a pinned clock and a pinned
 * timezone, in `src/lib/server/budget/dashboard.spec.ts`. This block pins the key to the French
 * word the user actually reads, so the two together say: at 2026-08-31 23:30 UTC the header used
 * to print « septembre 2026 » over August's figures, and now prints « août 2026 ».
 *
 * Deliberately not a second copy of `formatCurrentMonth` — it renders the real page and reads the
 * real subtitle, so a change to that helper is visible here rather than agreed with by a twin.
 */
describe('/budgets header month', () => {
	it('names août for the 2026-08 key that a UTC clock produces at the month boundary', async () => {
		const screen = render(Page, { data: baseData({ currentMonth: '2026-08' }), form: null });

		await expect.element(screen.getByText(/août 2026/)).toBeInTheDocument();
		expect(document.body.textContent).not.toContain('septembre 2026');
	});

	it('names septembre for 2026-09, so the assertion above is about the key and not the word', async () => {
		const screen = render(Page, { data: baseData({ currentMonth: '2026-09' }), form: null });

		await expect.element(screen.getByText(/septembre 2026/)).toBeInTheDocument();
	});
});
