import { page, userEvent } from 'vitest/browser';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';
import { TRANSACTION_NATURES, type TransactionNature } from '$lib/domain/transaction';

const goto = vi.hoisted(() => vi.fn());
// Spread the real module rather than replacing it: `$app/forms`' enhance imports `invalidateAll`
// from here, so a bare `{ goto }` factory fails the whole file at import time.
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto
}));

/**
 * `?ids=` is carried by SOME generated links and deliberately dropped by others, and which is
 * which is a decision, not an accident:
 *
 *  - CARRIED by buildPageHref, buildSelectedHref and buildExportHref — paging, opening a row and
 *    exporting all stay inside the id-filtered view. The export is the one that matters: it is a
 *    download of "what I'm looking at" with no visible result to compare against, and dropping it
 *    would silently produce a whole-history CSV from a five-row view.
 *  - DROPPED by buildFilterHref (tab switching), buildFocusHref (classification mode) and the two
 *    search forms — those visibly change the list, so the user sees they left.
 *
 * None of it is asserted by the shape of the code, and a refactor touching any one of the five
 * near-identical builders could add or remove a line silently. This file pins both sides.
 */

const SPENDING: TransactionNature = 'spending';
const IDS = 'transaction-1,transaction-2,transaction-3';

function makeTransaction(id: string) {
	return {
		id,
		date: '2026-06-12',
		label: `Merchant ${id}`,
		category: 'Alimentation',
		importedCategory: 'Alimentation',
		manualCategory: null,
		isManualCategory: false,
		nature: SPENDING,
		natureSource: 'default',
		manualNature: null,
		amountCents: 3_000,
		type: 'expense' as const,
		source: 'csv',
		suggestion: null
	};
}

function baseData(overrides: Record<string, unknown> = {}): PageData {
	return {
		user: { email: 'test@example.com', role: 'USER' as const },
		transactions: [makeTransaction('tx-1'), makeTransaction('tx-2')],
		selectedTransaction: null,
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
			ids: IDS
		},
		filteredTotals: { incomeCents: 0, expenseCents: 90_000 },
		queryError: false,
		dateRangeError: false,
		// Two pages, so the pagination control actually renders and buildPageHref is exercised.
		pagination: {
			page: 1,
			pageSize: 25,
			totalTransactions: 30,
			totalPages: 2,
			hasPrevious: false,
			hasNext: true
		},
		uncategorizedCount: 0,
		classifiableCount: 0,
		classifyStackIds: [],
		...overrides
	} as unknown as PageData;
}

/** Every rendered anchor, including anything Bits UI portalled out of the render container. */
function allHrefs(container: HTMLElement): string[] {
	return [...container.querySelectorAll('a[href]'), ...document.querySelectorAll('a[href]')]
		.map((anchor) => anchor.getAttribute('href') ?? '')
		.filter((href) => href.startsWith('/transactions'));
}

describe('?ids= propagation through the generated links', () => {
	it('carries ids into pagination, row selection and the export', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });

		const hrefs = allHrefs(container);

		const paging = hrefs.filter((href) => href.includes('page='));
		const selecting = hrefs.filter((href) => href.includes('selected='));
		const exporting = hrefs.filter((href) => href.startsWith('/transactions/export'));

		// Guard: an assertion over an empty set proves nothing. If a redesign stops rendering one
		// of these, this fails loudly instead of passing vacuously.
		expect(paging.length).toBeGreaterThan(0);
		expect(selecting.length).toBeGreaterThan(0);
		expect(exporting.length).toBeGreaterThan(0);

		for (const href of [...paging, ...selecting, ...exporting]) {
			expect(href).toContain(`ids=${encodeURIComponent(IDS)}`);
		}
	});

	it('drops ids from the tab links, which visibly change the list', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });

		const tabs = [...container.querySelectorAll('a[role="tab"]')].map(
			(tab) => tab.getAttribute('href') ?? ''
		);

		expect(tabs.length).toBeGreaterThan(0);
		for (const href of tabs) expect(href).not.toContain('ids=');
	});

	it('lets the all tab clear an active type filter rather than re-emitting it', async () => {
		// The regression this pins is user-visible and no type error catches it: with a specific
		// type filter active, the "Toutes" tab used to render an href byte-identical to the page
		// it was already on, so the tab did nothing. The classify-mode "Terminer" button is the
		// same call and was equally dead.
		//
		// Rendered rather than asserted on the builder alone, because the defect lived in what the
		// CALL SITE passed, not in the builder. A unit test on buildTransactionsHref cannot see it.
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({ filters: { ...baseData().filters, type: 'expense' } }),
			form: null
		});

		const tabs = [...container.querySelectorAll('a[role="tab"]')];
		expect(tabs.length).toBeGreaterThan(0);

		// The tab whose href carries no `type` is the "all" one, by construction.
		const allTabHrefs = tabs
			.map((tab) => tab.getAttribute('href') ?? '')
			.filter((href) => !new URLSearchParams(href.split('?')[1]).has('type'));

		// TWO, not one: this page renders a desktop and a mobile copy of the tab bar at the same
		// time, the same duplication already recorded against /reports and /upcoming-bills. Both
		// copies are asserted deliberately, so a fix that clears the filter on only one of them
		// goes red rather than half-passing.
		expect(allTabHrefs).toHaveLength(2);
		for (const href of allTabHrefs) expect(href).toBe('/transactions?');
	});

	it('drops ids from the focus-mode navigation', async () => {
		await page.viewport(1280, 800);
		goto.mockClear();
		render(Page, {
			data: baseData({ uncategorizedCount: 3, classifiableCount: 0, classifyStackIds: ['tx-1'] }),
			form: null
		});

		await userEvent.click(page.getByRole('button', { name: 'Mode focus' }).first());

		expect(goto).toHaveBeenCalledTimes(1);
		expect(String(goto.mock.calls[0][0])).not.toContain('ids=');
	});

	it('carries no ids hidden input in the search forms, so submitting one leaves the filtered view', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });

		const forms = [...container.querySelectorAll('form')].filter(
			(form) => (form.getAttribute('method') ?? 'get').toLowerCase() === 'get'
		);

		expect(forms.length).toBeGreaterThan(0);
		for (const form of forms) {
			expect(form.querySelector('input[name="ids"]')).toBeNull();
		}
	});

	it('tells the user a filter is active, since no field echoes it', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });

		// The whole point of the notice: with `?q=` the search box showed the term, so a short list
		// explained itself. `?ids=` has no field of its own and the bar would otherwise look empty.
		// The count is `pagination.totalTransactions` (2, the rows actually rendered), not the 3
		// ids in IDS: an anchor can point at a transaction since deleted, and the row count is the
		// honest number of what is on screen.
		expect(container.textContent).toContain('2');
		expect(container.textContent).toContain('liée(s) à une échéance');
	});

	it('reads correctly in the singular, when exactly one result is on screen', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({
				transactions: [makeTransaction('tx-1')],
				pagination: {
					page: 1,
					pageSize: 25,
					totalTransactions: 1,
					totalPages: 1,
					hasPrevious: false,
					hasNext: false
				}
			}),
			form: null
		});

		expect(container.textContent).toContain('1 transaction(s) liée(s) à une échéance');
	});

	it('says nothing when no id filter is active', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({ filters: { ...baseData().filters, ids: '' } }),
			form: null
		});

		expect(container.textContent).not.toContain('liées à une échéance');
	});
});
