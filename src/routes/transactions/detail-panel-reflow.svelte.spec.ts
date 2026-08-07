import { page } from 'vitest/browser';
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';
import { TRANSACTION_NATURES } from '$lib/domain/transaction';
import * as m from '$lib/paraglide/messages';

/**
 * The detail panel on demand (design section 11).
 *
 * Nothing occupies the place of nothing: with no selection the panel is not rendered at all — no
 * empty column, no "select a transaction" prompt — and the table takes the width. Selecting a row
 * narrows the table rather than covering it, strictly horizontally, so the row aimed at stays on
 * its own line at its exact ordinate.
 *
 * The two column sets are the whole of the geometric claim, so they are asserted as the exact class
 * strings rather than as "the table got narrower".
 */

const TX = {
	id: 'tx-1',
	date: '2026-06-22',
	label: 'Restaurante Adega',
	amountCents: -5210,
	type: 'expense' as const,
	category: 'Restaurants',
	importedCategory: 'Restaurants',
	manualCategory: null,
	isManualCategory: false,
	nature: 'spending' as const,
	manualNature: null,
	natureSource: 'category' as const,
	source: 'manual' as const,
	suggestion: null,
	tags: []
};

function baseData(overrides: Record<string, unknown> = {}): PageData {
	return {
		user: { email: 'test@example.com', role: 'USER' as const },
		transactions: [TX],
		selectedTransaction: null,
		selectedSuggestion: null,
		categoryOptions: ['Restaurants'],
		categories: [{ name: 'Restaurants', defaultKey: null }],
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
			tag: '',
			split: 'all'
		},
		filteredTotals: { incomeCents: 0, expenseCents: 5210 },
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

/** The detail payload the server sends for a selected row. */
function selected(overrides: Record<string, unknown> = {}) {
	return baseData({
		selectedTransaction: {
			...TX,
			manualCategory: null,
			manualNature: null,
			notes: null,
			bankOperationType: null,
			bankFields: [],
			account: null,
			importBatch: null,
			reference: null,
			dedupeKey: null,
			createdAt: '2026-06-22T10:00:00.000Z',
			updatedAt: '2026-06-22T10:00:00.000Z'
		},
		...overrides
	});
}

function panel(container: HTMLElement): HTMLElement | null {
	return container.querySelector<HTMLElement>('aside[data-testid="transaction-detail"]');
}

describe('detail panel on demand', () => {
	it('is not rendered at all without a selection, and nothing stands in for it', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });

		expect(panel(container)).toBeNull();
		// No "sélectionnez une transaction" placeholder either: an empty column announcing its own
		// emptiness is still an occupied column.
		expect(container.textContent).not.toContain(m.transactions_select_prompt());
	});

	it('appears on selection as a labelled region with a close control', async () => {
		expect.assertions(3);
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: selected(), form: null });

		const aside = panel(container);
		expect(aside).not.toBeNull();
		expect(aside?.getAttribute('aria-label')).toBe(m.transactions_detail_region_aria());
		expect(
			container.querySelector(`[aria-label="${m.transactions_detail_close_aria()}"]`)
		).not.toBeNull();
	});

	it('uses the roomy column set without a selection and the current one with it', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);

		// MEASURED, not read off the class list. The historic defect in this exact column was that the
		// header measured 190px while the rendered column was 262px — `w-[190px]` on a <td> under
		// `table-layout: auto` is only a suggestion, and a class-string assertion passes happily
		// against a column that is nothing like the figure it names.
		const width = (c: HTMLElement) =>
			c.querySelector<HTMLElement>('[data-testid="tags-cell"]')?.getBoundingClientRect().width;

		const roomy = render(Page, { data: baseData(), form: null });
		expect(width(roomy.container)).toBe(240);
		roomy.unmount();

		// 190px is today's set, unchanged: the narrowed state removes nothing, it is the unselected
		// state that gains air.
		const tight = render(Page, { data: selected(), form: null });
		expect(width(tight.container)).toBe(190);
	});

	it('caps a chip at 110px in BOTH column sets', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		// The column breathes; the chip does not grow. No referential value changes here — the new
		// state only adds air around the same objects. Measured on the element that actually carries
		// the cap, with a name long enough that an absent cap would show up as a wider box.
		const tagged = {
			...TX,
			tags: [{ id: 'tag-1', name: 'Vacances au Portugal', colorToken: 'clay' }]
		};
		const chipCap = (c: HTMLElement) => {
			const li = c.querySelector<HTMLElement>('[data-testid="tags-cell"] li');
			return li && getComputedStyle(li).maxWidth;
		};

		const roomy = render(Page, { data: baseData({ transactions: [tagged] }), form: null });
		expect(chipCap(roomy.container)).toBe('110px');
		roomy.unmount();

		const tight = render(Page, {
			data: selected({ transactions: [tagged] }),
			form: null
		});
		expect(chipCap(tight.container)).toBe('110px');
	});

	it('marks the selected row with aria-current and a non-chromatic border, never aria-selected', async () => {
		expect.assertions(5);
		await page.viewport(1280, 800);
		const OTHER = { ...TX, id: 'tx-2', label: 'Pastéis de Belém' };
		const { container } = render(Page, {
			data: selected({ transactions: [TX, OTHER] }),
			form: null
		});

		const row = container.querySelector<HTMLElement>('[data-testid="tx-row-tx-1"]');
		const other = container.querySelector<HTMLElement>('[data-testid="tx-row-tx-2"]');
		expect(row?.getAttribute('aria-current')).toBe('true');
		// The attribute is on the SELECTED row only. Without this half, marking every row would pass.
		expect(other?.getAttribute('aria-current')).toBeNull();
		// The 3px black edge doubles the zinc-50 fill, so selection never rests on a shade of grey.
		// Measured as a colour rather than a class: unselected rows carry the same 3px in transparent,
		// so that the cells do not shift sideways on selection, and only the colour distinguishes them.
		expect(getComputedStyle(row!).borderLeftWidth).toBe('3px');
		expect(getComputedStyle(other!).borderLeftColor).toBe('rgba(0, 0, 0, 0)');
		// aria-selected is only valid on option/row-in-a-grid/tab/gridcell. This is a plain <table>,
		// so setting it would be invalid ARIA that assistive technology may ignore or misreport.
		// Adopting role="grid" instead would oblige a full grid keyboard model for the whole table.
		// Scoped to the TABLES: the nature filter tabs carry a legitimate aria-selected as role="tab",
		// so a document-wide query would be red for a reason that has nothing to do with this rule.
		expect(
			[...container.querySelectorAll('table')].flatMap((t) => [
				...t.querySelectorAll('[aria-selected]')
			])
		).toHaveLength(0);
	});

	it('keeps a panel taller than the viewport reachable by scrolling', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: selected(), form: null });

		const sticky = container.querySelector<HTMLElement>('[data-testid="detail-sticky"]');
		expect(sticky).not.toBeNull();
		const style = getComputedStyle(sticky!);
		// position: sticky pins the top; without a bounded height and its own scroll, everything
		// past the fold is simply unreachable — the panel holds six sections and will exceed 800px.
		expect(style.overflowY).toBe('auto');
	});
});
