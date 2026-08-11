import { page, userEvent } from 'vitest/browser';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';
import { TRANSACTION_NATURES } from '$lib/domain/transaction';
import * as m from '$lib/paraglide/messages';

/**
 * The unsaved-changes guard (design section 11, amendment 2).
 *
 * Before this, switching rows silently discarded pending edits and clicking a nav link lost them
 * outright. All six paths — the header cross, Escape, a second click on the selected row, another
 * row, a nav link, and the browser's Back button — are covered by ONE `beforeNavigate`, because
 * every one of them is a navigation: the selection lives in `?selected=`.
 *
 * `beforeNavigate` is mocked to capture the callback rather than driving a real router: a
 * component render has no SvelteKit navigation lifecycle, so a real link click here would be a
 * full page load the harness cannot observe. What is asserted is exactly the contract the page
 * relies on — cancel unconditionally, then decide what to show.
 *
 * The NAV-AWAY path (clicking "Budgets") and the Back button are covered in e2e, where a real
 * router exists. They are deliberately absent here rather than forgotten.
 */

const goto = vi.hoisted(() => vi.fn());
const beforeNavigateCallbacks = vi.hoisted(() => [] as Array<(nav: unknown) => void>);
// Spread the real module rather than replacing it: `$app/forms`' enhance imports `invalidateAll`
// from here, so a bare factory fails the whole file at import time.
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto,
	beforeNavigate: (cb: (nav: unknown) => void) => {
		beforeNavigateCallbacks.push(cb);
	}
}));

/** The shape SvelteKit hands the callback, reduced to the three fields the guard reads. */
function navigation(overrides: Record<string, unknown> = {}) {
	return {
		cancel: vi.fn(),
		willUnload: false,
		to: { url: new URL('https://example.test/budgets') },
		...overrides
	};
}

const TAG = { id: 'tag-1', name: 'Portugal', colorToken: 'clay' };

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
	splitIndicator: null,
	matchedCategoryAllocation: null,
	suggestion: null,
	tags: [TAG]
};

function baseData(overrides: Record<string, unknown> = {}): PageData {
	return {
		user: { email: 'test@example.com', role: 'USER' as const },
		transactions: [TX],
		selectedTransaction: {
			// The three fields the split editor reads. Spelled out rather than defaulted, for the reason
			// EFFECTIVE_CATEGORY_SELECT's `splits` is required: an absent répartition and a forgotten
			// one look identical the moment either is optional.
			splits: [],
			splitInheritCategoryId: null,
			splitEntryAvailable: false,
			...TX,
			notes: null,
			bankOperationType: null,
			bankFields: [],
			account: null,
			importBatch: null,
			reference: null,
			dedupeKey: null,
			subcategory: '',
			createdAt: '2026-06-22T10:00:00.000Z',
			updatedAt: '2026-06-22T10:00:00.000Z'
		},
		selectedSuggestion: null,
		categoryOptions: ['Restaurants'],
		splitCategoryOptions: [],
		categories: [{ id: 'cat-restaurants', name: 'Restaurants' }],
		allTags: [TAG],
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

/** The page registers exactly one callback; fire it with the given navigation. */
function fireNavigate(nav: ReturnType<typeof navigation>) {
	expect(beforeNavigateCallbacks).toHaveLength(1);
	beforeNavigateCallbacks[0](nav);
	return nav;
}

/**
 * Makes the page dirty the way a user does: removes the one chip in the desktop panel's tags
 * editor. Nothing is submitted, so the change exists only in the component — which is precisely
 * the state the guard is about.
 */
async function makeDirty(container: HTMLElement) {
	const remove = container.querySelector<HTMLElement>(
		`aside[data-testid="transaction-detail"] [aria-label="${m.tags_remove_aria({ name: TAG.name })}"]`
	);
	expect(remove).not.toBeNull();
	await userEvent.click(remove!);
}

describe('unsaved-changes guard', () => {
	beforeEach(() => {
		beforeNavigateCallbacks.length = 0;
		goto.mockClear();
	});

	it('lets a navigation through untouched when nothing is dirty', async () => {
		expect.assertions(3);
		await page.viewport(1280, 800);
		render(Page, { data: baseData(), form: null });

		const nav = fireNavigate(navigation());
		expect(nav.cancel).not.toHaveBeenCalled();
		expect(
			page.getByRole('heading', { name: m.transactions_unsaved_title() }).elements()
		).toHaveLength(0);
	});

	it('cancels and asks when a tag was changed but not saved', async () => {
		expect.assertions(4);
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });
		await makeDirty(container);

		const nav = fireNavigate(navigation());
		// Cancelled UNCONDITIONALLY and first: `beforeNavigate` is synchronous, so there is no
		// awaiting the user's answer inside it.
		expect(nav.cancel).toHaveBeenCalledOnce();
		// By ROLE: ConfirmDialog renders the title twice on purpose (the sr-only Modal heading and a
		// visible mobile-style <p>), so a bare text query is strict-mode ambiguous.
		await expect
			.element(page.getByRole('heading', { name: m.transactions_unsaved_title() }))
			.toBeInTheDocument();
	});

	it('"Rester" dismisses the question and goes nowhere', async () => {
		expect.assertions(4);
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });
		await makeDirty(container);
		fireNavigate(navigation());

		await userEvent.click(page.getByRole('button', { name: m.transactions_unsaved_stay() }));
		expect(
			page.getByRole('heading', { name: m.transactions_unsaved_title() }).elements()
		).toHaveLength(0);
		// The navigation is DROPPED, not deferred: the guard already cancelled it, and nothing
		// replays it. A `goto` here would send the user away from the work they chose to keep.
		expect(goto).not.toHaveBeenCalled();
	});

	it('"Abandonner" replays the exact navigation that was cancelled', async () => {
		expect.assertions(3);
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });
		await makeDirty(container);
		const target = new URL('https://example.test/budgets?month=2026-06');
		fireNavigate(navigation({ to: { url: target } }));

		await userEvent.click(page.getByRole('button', { name: m.transactions_unsaved_discard() }));
		// The URL, in full. Replaying "/budgets" instead of the captured target would drop whatever
		// the user actually clicked — a month, a filter, an anchor.
		expect(goto).toHaveBeenCalledWith(target, { noScroll: true });
	});

	it('a tab close is cancelled but raises no dialog of ours', async () => {
		expect.assertions(4);
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });
		await makeDirty(container);

		const nav = fireNavigate(navigation({ willUnload: true, to: null }));
		// For `type: 'leave'` SvelteKit turns the cancel into `preventDefault()` on `beforeunload`,
		// so the user sees THE BROWSER'S dialog. Rendering ours underneath it would stack two
		// questions about the same thing, and the second would still be there after the first is
		// answered — the tab is gone, the page is not.
		expect(nav.cancel).toHaveBeenCalledOnce();
		expect(
			page.getByRole('heading', { name: m.transactions_unsaved_title() }).elements()
		).toHaveLength(0);
	});
});
