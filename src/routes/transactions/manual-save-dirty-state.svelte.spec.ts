import { page, userEvent } from 'vitest/browser';
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';
import { TRANSACTION_NATURES, type TransactionNature } from '$lib/domain/transaction';

const SPENDING: TransactionNature = 'spending';

// Verifies the dirty-gate on the "Enregistrer" buttons for manual category/nature
// (transactions/+page.svelte:288-289 categoryIsDirty/natureIsDirty): disabled while the
// selected value matches what's saved, enabled once it differs, disabled again on revert.
// Runs against the desktop detail panel (<aside>) and the mobile bottom sheet — same
// $derived values drive both, but each renders its own DOM, so both are exercised
// independently to catch a regression specific to either markup.

function baseData(overrides: Record<string, unknown> = {}): PageData {
	return {
		user: { email: 'test@example.com', role: 'USER' as const },
		transactions: [
			{
				id: 'tx-1',
				date: '2026-06-12',
				label: 'Carrefour Market',
				category: 'Alimentation',
				importedCategory: 'Alimentation',
				manualCategory: 'Alimentation',
				isManualCategory: true,
				nature: SPENDING,
				natureSource: 'manual' as const,
				manualNature: SPENDING,
				amountCents: -5420,
				type: 'expense' as const,
				source: 'Carrefour Market SA',
				tags: [],
				splitIndicator: null,
				matchedCategoryAllocation: null,
				suggestion: null
			}
		],
		selectedTransaction: {
			// The three fields the split editor reads. Spelled out rather than defaulted, for the reason
			// EFFECTIVE_CATEGORY_SELECT's `splits` is required: an absent répartition and a forgotten
			// one look identical the moment either is optional.
			splits: [],
			splitInheritCategoryId: null,
			splitEntryAvailable: false,
			id: 'tx-1',
			date: '2026-06-12',
			label: 'Carrefour Market',
			amountCents: -5420,
			type: 'expense' as const,
			category: 'Alimentation',
			importedCategory: 'Alimentation',
			manualCategory: 'Alimentation',
			isManualCategory: true,
			nature: SPENDING,
			natureSource: 'manual' as const,
			manualNature: SPENDING,
			source: 'Carrefour Market SA',
			notes: null,
			reference: null,
			dedupeKey: null,
			createdAt: '2026-06-12T10:00:00.000Z',
			updatedAt: '2026-06-12T10:00:00.000Z',
			account: null,
			importBatch: null,
			bankFields: [],
			bankOperationType: null,
			subcategory: '',
			tags: []
		},
		allTags: [],
		selectedSuggestion: null,
		categoryOptions: ['Alimentation', 'Abonnements', 'Loisirs'],
		splitCategoryOptions: [],
		categories: [
			{ id: 'cat-alimentation', name: 'Alimentation' },
			{ id: 'cat-abonnements', name: 'Abonnements' },
			{ id: 'cat-loisirs', name: 'Loisirs' }
		],
		natureOptions: TRANSACTION_NATURES,
		splitFilterAvailable: false,
		splitCounts: null,
		filters: {
			q: '',
			qMode: 'contains' as const,
			type: 'all',
			category: '',
			from: '',
			to: '',
			importBatchId: '',
			ids: '',
			tag: '',
			split: 'all'
		},
		filteredTotals: { incomeCents: 0, expenseCents: 5420 },
		queryError: false,
		dateRangeError: false,
		pagination: {
			page: 1,
			pageSize: 25,
			totalTransactions: 1,
			totalPages: 1,
			hasPrevious: false,
			hasNext: false
		},
		uncategorizedCount: 0,
		classifiableCount: 0,
		classifyStackIds: [],
		tagCounts: null,
		tagScopeTotal: 0,
		bulkFallback: null,
		todayIso: '2026-06-17',
		...overrides
	};
}

describe('manual category/nature save button dirty state', () => {
	it('desktop: disabled by default, enabled on change, disabled again on revert', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });

		const aside = container.querySelector('aside') as HTMLElement;
		const natureSection = aside.querySelectorAll('section')[1] as HTMLElement;
		const saveBtn = natureSection.querySelector('button[type="submit"]') as HTMLButtonElement;

		expect(saveBtn.disabled).toBe(true);

		const trigger = page.getByRole('button', { name: 'Nature manuelle' });
		await userEvent.click(trigger);
		await userEvent.click(page.getByRole('option', { name: 'Transfert' }));
		expect(saveBtn.disabled).toBe(false);

		await userEvent.click(trigger);
		await userEvent.click(page.getByRole('option', { name: 'Dépense réelle' }));
		expect(saveBtn.disabled).toBe(true);
	});

	it('mobile: disabled by default, enabled on change, disabled again on revert', async () => {
		await page.viewport(390, 844);
		render(Page, { data: baseData(), form: null });

		const sheet = page.getByRole('dialog');
		const trigger = sheet.getByRole('button', { name: 'Nature manuelle' });
		const saveBtn = sheet.getByRole('button', { name: 'Enregistrer' }).nth(1);

		await expect.element(saveBtn).toBeDisabled();

		await userEvent.click(trigger);
		await userEvent.click(page.getByRole('option', { name: 'Transfert' }));
		await expect.element(saveBtn).toBeEnabled();

		await userEvent.click(trigger);
		await userEvent.click(page.getByRole('option', { name: 'Dépense réelle' }));
		await expect.element(saveBtn).toBeDisabled();
	});
});
