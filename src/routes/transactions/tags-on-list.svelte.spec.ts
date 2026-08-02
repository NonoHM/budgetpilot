import { page } from 'vitest/browser';
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';
import { TRANSACTION_NATURES, type TransactionNature } from '$lib/domain/transaction';

const SPENDING: TransactionNature = 'spending';

/**
 * Wiring for transactions/+page.svelte:5.1 step 5 (TagChips on the desktop table row and the
 * mobile ListCard) and the TransactionTagsEditor mount in the detail panel / bottom sheet. The
 * cap-at-2-plus-N behaviour itself is exhaustively covered at the component level
 * (ui/TagChips.svelte.spec.ts); what only a browser render of the real page can prove is that a
 * transaction's tags actually reach TagChips through the row markup, on both surfaces — the exact
 * shape of defect #97 found (a control wired on one surface and silently missing on the other).
 */

const THREE_TAGS = [
	{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' },
	{ id: 'tag-2', name: 'Pro', colorToken: 'ochre' },
	{ id: 'tag-3', name: 'Remboursement Paul', colorToken: 'olive' }
];

function makeTransaction(overrides: Record<string, unknown> = {}) {
	return {
		id: 'tx-1',
		date: '2026-06-12',
		label: 'Carrefour Market',
		category: 'Alimentation',
		importedCategory: 'Alimentation',
		manualCategory: null,
		isManualCategory: false,
		nature: SPENDING,
		natureSource: 'default' as const,
		manualNature: null,
		amountCents: -5420,
		type: 'expense' as const,
		source: 'Carrefour Market SA',
		tags: THREE_TAGS,
		suggestion: null,
		...overrides
	};
}

function baseData(overrides: Record<string, unknown> = {}): PageData {
	return {
		user: { email: 'test@example.com', role: 'USER' as const },
		transactions: [makeTransaction()],
		selectedTransaction: {
			id: 'tx-1',
			date: '2026-06-12',
			label: 'Carrefour Market',
			amountCents: -5420,
			type: 'expense' as const,
			category: 'Alimentation',
			importedCategory: 'Alimentation',
			manualCategory: null,
			isManualCategory: false,
			nature: SPENDING,
			natureSource: 'default' as const,
			manualNature: null,
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
			tags: [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' }]
		},
		allTags: THREE_TAGS,
		selectedSuggestion: null,
		categoryOptions: ['Alimentation'],
		categories: [{ name: 'Alimentation', defaultKey: null }],
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
		...overrides
	};
}

describe('tag chips on the transactions list rows', () => {
	// Both the desktop table and the mobile ListCard render simultaneously regardless of viewport
	// (same shape CLAUDE.md records for /upcoming-bills and /reports), so every assertion here is
	// scoped to ONE surface's row rather than to the page as a whole: an unscoped getByText would
	// also match the OTHER surface's row, and — once a transaction is selected — the detail
	// panel's own TagPicker chip for the same tag name.

	it('desktop: shows the first two tags and collapses the third as +1', async () => {
		await page.viewport(1280, 800);
		render(Page, { data: baseData(), form: null });

		const table = page.getByRole('table');
		await expect.element(table.getByText('Portugal')).toBeInTheDocument();
		await expect.element(table.getByText('Pro')).toBeInTheDocument();
		expect(table.getByText('Remboursement Paul').elements().length).toBe(0);
		await expect
			.element(table.getByRole('button', { name: /1 étiquette de plus/ }))
			.toBeInTheDocument();
	});

	it('mobile: shows the first two tags and collapses the third as +1', async () => {
		await page.viewport(390, 844);
		const { container } = render(Page, {
			data: baseData({ selectedTransaction: null }),
			form: null
		});

		const row = container.querySelector('#tx-row-tx-1') as HTMLElement;
		expect(row.textContent).toContain('Portugal');
		expect(row.textContent).toContain('Pro');
		expect(row.textContent).not.toContain('Remboursement Paul');
	});

	it('renders no chip at all for a transaction with no tags', async () => {
		await page.viewport(1280, 800);
		render(Page, {
			data: baseData({
				transactions: [makeTransaction({ tags: [] })],
				selectedTransaction: null
			}),
			form: null
		});

		expect(page.getByRole('table').getByText('Portugal').elements().length).toBe(0);
	});
});

describe('TransactionTagsEditor mounted on the detail surfaces', () => {
	it('desktop: the panel offers the tags section with the current tag as a removable chip', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });

		const aside = container.querySelector('aside') as HTMLElement;
		expect(aside.textContent).toContain('Étiquettes');
		await expect
			.element(page.getByRole('button', { name: "Retirer l'étiquette Portugal" }))
			.toBeInTheDocument();
	});

	it('mobile: the bottom sheet offers the tags section with the current tag as a removable chip', async () => {
		await page.viewport(390, 844);
		render(Page, { data: baseData(), form: null });

		const sheet = page.getByRole('dialog');
		await expect.element(sheet.getByRole('heading', { name: 'Étiquettes' })).toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: "Retirer l'étiquette Portugal" }))
			.toBeInTheDocument();
	});
});
