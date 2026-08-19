import { page } from 'vitest/browser';
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';
import { TRANSACTION_NATURES, type TransactionNature } from '$lib/domain/transaction';
import * as m from '$lib/paraglide/messages';

const SPENDING: TransactionNature = 'spending';

/**
 * The detail panel's forms POST to a URL, and that URL is the WHOLE query string.
 *
 * A bare `action="?/saveManualCategory"` resolves to `/transactions?/saveManualCategory`, so a
 * native submit lands on a page with no `selected`, no filters and no page number: the panel the
 * form lives in is gone, and with it the only place its refusal is rendered. `saveSplits` already
 * carries the selection for exactly this reason (+page.svelte's `splitFormAction` docstring); this
 * asserts its three siblings in the same panel do too.
 *
 * The action is parsed the way SvelteKit parses it — the param whose key starts with `/` names the
 * action, every other param rides along — rather than compared against a rebuilt string, so this
 * test shares no source with the builder it is checking.
 */
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
		// Every dimension the panel must not silently drop, set to a value a user could have chosen.
		filters: {
			q: 'carrefour',
			qMode: 'contains' as const,
			type: 'expense',
			category: 'Alimentation',
			from: '2026-06-01',
			to: '2026-06-30',
			importBatchId: '',
			ids: '',
			tag: 'Voyage',
			split: 'all'
		},
		filteredTotals: { incomeCents: 0, expenseCents: 5420 },
		queryError: false,
		dateRangeError: false,
		pagination: {
			page: 3,
			pageSize: 25,
			totalTransactions: 1,
			totalPages: 4,
			hasPrevious: true,
			hasNext: true
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

/** The action's query string, parsed as SvelteKit's own action resolution parses it. */
function actionParams(form: Element): URLSearchParams {
	const action = form.getAttribute('action') ?? '';
	return new URLSearchParams(action.slice(action.indexOf('?') + 1));
}

function expectCarriesSelectionAndFilters(form: Element, actionName: string): void {
	const params = actionParams(form);
	// The action itself: SvelteKit reads the param whose key starts with '/'.
	expect(params.has(`/${actionName}`)).toBe(true);
	expect(params.get('selected')).toBe('tx-1');
	expect(params.get('page')).toBe('3');
	expect(params.get('q')).toBe('carrefour');
	expect(params.get('category')).toBe('Alimentation');
	expect(params.get('from')).toBe('2026-06-01');
	expect(params.get('to')).toBe('2026-06-30');
	expect(params.get('tag')).toBe('Voyage');
	expect(params.get('type')).toBe('expense');
}

describe('the detail panel posts without discarding the panel', () => {
	it('manual category: both mounts carry the selection and every active filter', async () => {
		await page.viewport(1280, 900);
		const { container } = render(Page, { data: baseData(), form: null });

		// Absolute figure beside the sweep: desktop panel and mobile sheet are both mounted at every
		// width and only one is shown by CSS, so a fix landing on one of them must not read as green.
		const forms = container.querySelectorAll('form[action$="/saveManualCategory"]');
		expect(forms.length).toBe(2);

		for (const form of forms) expectCarriesSelectionAndFilters(form, 'saveManualCategory');
	});

	it('manual category: a refusal is announced, in the form it belongs to', async () => {
		await page.viewport(1280, 900);
		// The refusal a user reaches by ordinary means: the parent's category is frozen while the
		// transaction is répartie, and the server refuses the write (+page.server.ts's
		// `splits: { none: {} }` guard). Before the panel survived the submit this sentence was
		// computed, returned, and rendered nowhere.
		const { container } = render(Page, {
			data: baseData(),
			form: { manualCategoryError: m.transactions_error_category_locked_by_split() }
		});

		const forms = container.querySelectorAll('form[action$="/saveManualCategory"]');
		expect(forms.length).toBe(2);

		for (const form of forms) {
			// Announced rather than merely coloured: it arrives with nothing else on screen changing,
			// so a reader who is not looking at this corner of the panel has no other signal. Colour
			// alone would also be the only carrier of "this is a refusal".
			const alert = form.querySelector('[role="alert"]');
			expect(alert).not.toBeNull();
			expect(alert?.textContent).toContain(m.transactions_error_category_locked_by_split());
		}
	});

	it('manual nature: both mounts carry the selection and every active filter', async () => {
		await page.viewport(1280, 900);
		const { container } = render(Page, { data: baseData(), form: null });

		const forms = container.querySelectorAll('form[action$="/saveManualNature"]');
		expect(forms.length).toBe(2);

		for (const form of forms) expectCarriesSelectionAndFilters(form, 'saveManualNature');
	});

	it('manual nature: a refusal is announced, in the form it belongs to', async () => {
		await page.viewport(1280, 900);
		// The refusal this form can actually produce: the Select offers only valid natures, so the
		// reachable answer is the row having gone (deleted in another tab) between the selection and
		// the submit.
		const { container } = render(Page, {
			data: baseData(),
			form: { manualNatureError: m.transactions_error_transaction_not_found() }
		});

		const forms = container.querySelectorAll('form[action$="/saveManualNature"]');
		expect(forms.length).toBe(2);

		for (const form of forms) {
			const alert = form.querySelector('[role="alert"]');
			expect(alert).not.toBeNull();
			expect(alert?.textContent).toContain(m.transactions_error_transaction_not_found());
		}
	});
});
