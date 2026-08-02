import { page } from 'vitest/browser';
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';
import { TRANSACTION_NATURES } from '$lib/domain/transaction';

/**
 * The tag filter control (transactions/+page.svelte, both filter forms): progressive disclosure
 * per the design (5.1) means the control renders only when `data.allTags.length > 0`, so a user
 * who never uses tags never sees the concept. Asserted on both the desktop and mobile filter
 * forms, since each renders its own independent markup (same shape as the ids-filter-links and
 * manual-save-dirty-state specs beside this one).
 */

function baseData(overrides: Record<string, unknown> = {}): PageData {
	return {
		user: { email: 'test@example.com', role: 'USER' as const },
		transactions: [],
		selectedTransaction: null,
		selectedSuggestion: null,
		categoryOptions: ['Alimentation'],
		categories: [{ name: 'Alimentation', defaultKey: null }],
		allTags: [],
		natureOptions: TRANSACTION_NATURES,
		filters: {
			q: '',
			qMode: 'contains' as const,
			type: 'all',
			category: '',
			from: '',
			to: '',
			importBatchId: '',
			ids: '',
			tag: ''
		},
		filteredTotals: { incomeCents: 0, expenseCents: 0 },
		queryError: false,
		dateRangeError: false,
		pagination: {
			page: 1,
			pageSize: 25,
			totalTransactions: 0,
			totalPages: 1,
			hasPrevious: false,
			hasNext: false
		},
		uncategorizedCount: 0,
		classifiableCount: 0,
		classifyStackIds: [],
		...overrides
	};
}

const SPENDING_TAG_OPTIONS = [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }];

describe('tag filter control', () => {
	it('desktop: is absent for a user with no tags', async () => {
		await page.viewport(1280, 800);
		render(Page, { data: baseData(), form: null });

		expect(page.getByRole('combobox', { name: 'Filtrer par étiquette' }).elements().length).toBe(0);
	});

	it('desktop: renders once the user has at least one tag', async () => {
		await page.viewport(1280, 800);
		render(Page, { data: baseData({ allTags: SPENDING_TAG_OPTIONS }), form: null });

		await expect
			.element(page.getByRole('combobox', { name: 'Filtrer par étiquette' }))
			.toBeInTheDocument();
	});

	it('mobile: is absent for a user with no tags', async () => {
		await page.viewport(390, 844);
		render(Page, { data: baseData(), form: null });

		expect(page.getByRole('combobox', { name: 'Filtrer par étiquette' }).elements().length).toBe(0);
	});

	it('mobile: renders once the user has at least one tag', async () => {
		await page.viewport(390, 844);
		render(Page, { data: baseData({ allTags: SPENDING_TAG_OPTIONS }), form: null });

		await expect
			.element(page.getByRole('combobox', { name: 'Filtrer par étiquette' }))
			.toBeInTheDocument();
	});
});
