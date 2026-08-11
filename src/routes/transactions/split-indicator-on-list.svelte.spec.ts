import { page } from 'vitest/browser';
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
// Load-bearing for every measurement below, and not optional: without it the meta line's `h-[22px]`
// does nothing and the pinning test would report a plausible UA-default figure. See CLAUDE.md.
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';
import { TRANSACTION_NATURES, type TransactionNature } from '$lib/domain/transaction';
import * as m from '$lib/paraglide/messages';

/**
 * Wiring for the row indicator (design 1l–1o) on BOTH surfaces.
 *
 * The rule is proven in domain/allocation.spec.ts and the two badge forms in
 * ui/SplitBadge.svelte.spec.ts. What only a browser render of the real page can show is that a
 * répartition reaches the row markup at all, on each surface separately — the exact shape of defect
 * #97, a control wired on one surface and silently missing on the other — and that the Catégorie
 * cell stops printing the parent's category once it does.
 */

const SPENDING: TransactionNature = 'spending';
const TRANSFER: TransactionNature = 'transfer';

const SPLIT_INDICATOR = {
	dominantCategory: 'Maison',
	dominantNature: TRANSFER,
	otherCategoryCount: 1,
	partCount: 2,
	parts: [
		{ category: 'Maison', amountCents: -9240 },
		{ category: 'Transport', amountCents: -4250 }
	]
};

function makeTransaction(overrides: Record<string, unknown> = {}) {
	return {
		id: 'tx-1',
		date: '2026-06-12',
		label: 'Leroy Merlin',
		// The PARENT's category and nature, which a répartie row must stop showing.
		category: 'Alimentation',
		importedCategory: 'Alimentation',
		manualCategory: null,
		isManualCategory: false,
		nature: SPENDING,
		natureSource: 'default' as const,
		manualNature: null,
		amountCents: -13490,
		type: 'expense' as const,
		source: 'Leroy Merlin',
		tags: [],
		splitIndicator: null,
		matchedCategoryAllocation: null,
		suggestion: null,
		...overrides
	};
}

function baseData(overrides: Record<string, unknown> = {}): PageData {
	return {
		user: { email: 'test@example.com', role: 'USER' as const },
		transactions: [makeTransaction()],
		selectedTransaction: null,
		allTags: [],
		selectedSuggestion: null,
		categoryOptions: ['Alimentation', 'Maison', 'Transport'],
		splitCategoryOptions: [],
		categories: [
			{ id: 'cat-alimentation', name: 'Alimentation' },
			{ id: 'cat-maison', name: 'Maison' },
			{ id: 'cat-transport', name: 'Transport' }
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
		filteredTotals: { incomeCents: 0, expenseCents: 13490 },
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

describe('the répartition indicator on the transactions list', () => {
	// Both surfaces render simultaneously whatever the viewport (the shape CLAUDE.md records for
	// /reports and /upcoming-bills), so every assertion below is scoped to ONE of them.

	it('desktop: prints the DOMINANT category in place of the parent, with the badge beside it', async () => {
		expect.assertions(3);
		await page.viewport(1280, 800);
		render(Page, {
			data: baseData({ transactions: [makeTransaction({ splitIndicator: SPLIT_INDICATOR })] }),
			form: null
		});

		const table = page.getByRole('table');
		await expect.element(table.getByText('Maison', { exact: true })).toBeInTheDocument();
		// The parent's own category is a restoration value; showing it here would be a false
		// statement about where 92,40 € went, and one nothing on screen could contradict.
		expect(table.getByText('Alimentation', { exact: true }).elements()).toHaveLength(0);
		await expect
			.element(table.getByRole('button', { name: /Répartie entre 2 catégories/ }))
			.toBeInTheDocument();
	});

	it('desktop: line 2 describes the SAME part line 1 names (OD-4)', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({ transactions: [makeTransaction({ splitIndicator: SPLIT_INDICATOR })] }),
			form: null
		});

		const table = container.querySelector('table') as HTMLElement;
		// `transfer` is the dominant PART's nature; the parent resolves `spending`. Printing the
		// parent's would make the two lines describe different parts of the same transaction.
		expect(table.textContent).toContain(m.nature_transfer());
		expect(table.textContent).not.toContain(m.nature_spending());
	});

	it('desktop: the dot agrees with the name beside it', async () => {
		expect.assertions(1);
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({
				transactions: [
					makeTransaction({ id: 'tx-split', splitIndicator: SPLIT_INDICATOR }),
					// The relational control: an ORDINARY row whose category is the split row's
					// dominant one. The two dots must carry the same colour, which a single-row
					// measurement could not show either way — the failure being tested for is a
					// disagreement, not a value.
					makeTransaction({ id: 'tx-plain', label: 'Bricolage', category: 'Maison' })
				]
			}),
			form: null
		});

		const dots = Array.from(
			(container.querySelector('table') as HTMLElement).querySelectorAll('td .rounded-full')
		).map((dot) => getComputedStyle(dot as HTMLElement).backgroundColor);
		expect(new Set(dots).size).toBe(1);
	});

	it('mobile: the badge is inert, and says what it is anyway', async () => {
		expect.assertions(3);
		await page.viewport(390, 844);
		const { container } = render(Page, {
			data: baseData({
				transactions: [makeTransaction({ splitIndicator: SPLIT_INDICATOR })]
			}),
			form: null
		});

		const row = container.querySelector('#tx-row-tx-1') as HTMLElement;
		expect(row).not.toBeNull();
		// No second destination inside a row that is already one target.
		expect(row.querySelectorAll('button')).toHaveLength(0);
		expect(row.textContent).toContain(m.splits_row_badge_others_short({ count: 2 }));
	});

	// Appear-then-disappear. Polling for an absent badge on its own would pass while the page had
	// not mounted, while the table was empty, and for a dozen reasons unrelated to the rule.
	it('renders no badge at all on an unsplit row, on either surface', async () => {
		expect.assertions(4);
		await page.viewport(1280, 800);
		const { container, rerender } = render(Page, {
			data: baseData({ transactions: [makeTransaction({ splitIndicator: SPLIT_INDICATOR })] }),
			form: null
		});

		await expect
			.element(page.getByRole('button', { name: /Répartie entre 2 catégories/ }))
			.toBeInTheDocument();
		expect(container.textContent).toContain('+1');

		await rerender({ data: baseData(), form: null });
		await expect
			.element(page.getByRole('button', { name: /Répartie entre 2 catégories/ }))
			.not.toBeInTheDocument();
		expect(container.textContent).not.toContain('+1');
	});

	/**
	 * 1n/1o's pinning, and the half that proves it is a pinning rather than a coincidence.
	 *
	 * A test that only measured a row WITH a badge would pass with the height paid by the badge
	 * itself — which is the defect, not the fix. What has to be true is that the line already
	 * reserves 22px on a row that has nothing to put in it, so a répartition costs no height at the
	 * moment it appears.
	 */
	it('mobile: the meta line measures 22px WITHOUT a badge, and the row does not grow when one arrives', async () => {
		expect.assertions(3);
		await page.viewport(390, 844);
		const { container, rerender } = render(Page, { data: baseData(), form: null });

		const rowOf = () => container.querySelector('#tx-row-tx-1') as HTMLElement;
		const metaOf = () => {
			const label = rowOf().querySelector('p') as HTMLElement;
			return (label.nextElementSibling as HTMLElement).getBoundingClientRect().height;
		};

		const plainMeta = metaOf();
		const plainRow = rowOf().getBoundingClientRect().height;
		// Unpinned this line measures 16px, not the design's stated 15 — break-checked, and the
		// removal reports `expected 16 to be 22`. So the reservation costs 6px per mobile row rather
		// than 7; the argument is unchanged and the figure is the measured one.
		expect(plainMeta).toBe(22);

		await rerender({
			data: baseData({ transactions: [makeTransaction({ splitIndicator: SPLIT_INDICATOR })] }),
			form: null
		});
		expect(metaOf()).toBe(plainMeta);
		// The line height alone is not the invariant the design is defending — the ROW's is. A badge
		// that fitted its line while adding a margin would pass the assertion above and still grow
		// the list, which is the tags-chantier regression precisely.
		expect(rowOf().getBoundingClientRect().height).toBe(plainRow);
	});
});
