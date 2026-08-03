import { page, userEvent } from 'vitest/browser';
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';
import { TRANSACTION_NATURES } from '$lib/domain/transaction';
import * as m from '$lib/paraglide/messages';

/**
 * The tag filter control (transactions/+page.svelte, both filter forms): progressive disclosure
 * per the design (5.1) means the control renders only when `data.allTags.length > 0`, so a user
 * who never uses tags never sees the concept. Asserted on both the desktop and mobile filter
 * forms, since each renders its own independent markup (same shape as the ids-filter-links and
 * manual-save-dirty-state specs beside this one).
 *
 * The locator is the TRIGGER BUTTON named after its dimension, not a combobox. These four cases
 * previously queried `getByRole('combobox', { name: 'Filtrer par étiquette' })`, and when the
 * control became a listbox trigger the two "is absent" cases kept passing for the wrong reason —
 * there is no combobox in EITHER state now, so they asserted nothing. The role has to be the one
 * the control actually has, or half this file is decoration.
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
		tagCounts: null,
		tagScopeTotal: 0,
		bulkFallback: null,
		todayIso: '2026-06-17',
		...overrides
	};
}

const SPENDING_TAG_OPTIONS = [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }];

/**
 * The DESKTOP tag dimension's trigger. Located by its own text rather than by position: an index
 * into the bar's buttons picked the category dropdown instead, which has no counts, so the panel
 * that opened was the wrong one and the assertion below read a state it was never about.
 */
function tagTrigger(container: HTMLElement): HTMLElement {
	const trigger = [...container.querySelectorAll<HTMLElement>('.lg\\:block button')].find((b) =>
		b.textContent?.trim().startsWith(m.tags_filter_dimension())
	);
	if (!trigger) throw new Error('desktop tag filter trigger not found');
	return trigger;
}

describe('tag filter control', () => {
	it('desktop: is absent for a user with no tags', async () => {
		await page.viewport(1280, 800);
		render(Page, { data: baseData(), form: null });

		expect(page.getByRole('button', { name: m.tags_filter_dimension() }).elements().length).toBe(0);
	});

	it('desktop: renders once the user has at least one tag', async () => {
		await page.viewport(1280, 800);
		render(Page, { data: baseData({ allTags: SPENDING_TAG_OPTIONS }), form: null });

		await expect
			.element(page.getByRole('button', { name: m.tags_filter_dimension() }).first())
			.toBeInTheDocument();
	});

	it('mobile: is absent for a user with no tags', async () => {
		await page.viewport(390, 844);
		render(Page, { data: baseData(), form: null });

		expect(page.getByRole('button', { name: m.tags_filter_dimension() }).elements().length).toBe(0);
	});

	it('mobile: renders once the user has at least one tag', async () => {
		await page.viewport(390, 844);
		render(Page, { data: baseData({ allTags: SPENDING_TAG_OPTIONS }), form: null });

		await expect
			.element(page.getByRole('button', { name: m.tags_filter_dimension() }).first())
			.toBeInTheDocument();
	});

	it('desktop: says the counts are unavailable rather than claiming a scope they do not have', async () => {
		expect.assertions(4);
		await page.viewport(1280, 800);

		// `tagCounts: null` is a documented state: the load catches a failed count query and the UI
		// is meant to say so. Desktop kept claiming "Comptes dans le filtre courant." while every row
		// beside it rendered "—", so the header contradicted the numbers under it. Mobile already had
		// the branch and desktop did not — the same one-surface-only shape this repo keeps finding.
		const unavailable = render(Page, {
			data: baseData({ allTags: SPENDING_TAG_OPTIONS, tagCounts: null }),
			form: null
		});
		await userEvent.click(tagTrigger(unavailable.container));
		expect(unavailable.container.textContent).toContain(m.tags_filter_counts_unavailable());
		expect(unavailable.container.textContent).not.toContain(m.tags_filter_scope_note());
		unavailable.unmount();

		const scoped = render(Page, {
			data: baseData({ allTags: SPENDING_TAG_OPTIONS, tagCounts: [{ tagId: 'tag-1', count: 2 }] }),
			form: null
		});
		await userEvent.click(tagTrigger(scoped.container));
		expect(scoped.container.textContent).toContain(m.tags_filter_scope_note());
		expect(scoped.container.textContent).not.toContain(m.tags_filter_counts_unavailable());
	});
});
