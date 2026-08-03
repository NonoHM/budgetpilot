import { page } from 'vitest/browser';
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';
import { TRANSACTION_NATURES } from '$lib/domain/transaction';
import * as m from '$lib/paraglide/messages';

/**
 * The filtered-set totals, and the three states the design requires to be told apart
 * ("TROIS ÉTATS QUI NE SE RESSEMBLENT PAS", section 4C):
 *
 *   normal  — the figures
 *   zero    — the filter answered and there is nothing: writes "0,00 €"
 *   error   — the query never ran: writes "—", because "un tiret n'est pas un montant : il dit
 *             « on ne sait pas », ce qui est exactement la vérité"
 *
 * As shipped there was one rendering for all three, gated on `incomeCents > 0 || expenseCents > 0`,
 * so a true zero and a failed query both rendered NOTHING and were indistinguishable — while the
 * page still asserted "0 transaction" and "Aucune transaction pour ces critères", two statements
 * the server cannot make when it never evaluated the filter.
 *
 * Rendered in a real browser rather than asserted over source text: what is under test is which of
 * three renderings a reader actually gets, and `role`/`aria-live` are only meaningful as computed
 * attributes on a live node.
 */

function baseData(overrides: Record<string, unknown> = {}): PageData {
	return {
		user: { email: 'test@example.com', role: 'USER' as const },
		transactions: [],
		selectedTransaction: null,
		selectedSuggestion: null,
		categoryOptions: ['Loyer'],
		categories: [{ name: 'Loyer', defaultKey: null }],
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
		filteredTotals: { incomeCents: 12000, expenseCents: 71270 },
		queryError: false,
		dateRangeError: false,
		pagination: {
			page: 1,
			pageSize: 25,
			totalTransactions: 6,
			totalPages: 1,
			hasPrevious: false,
			hasNext: false
		},
		uncategorizedCount: 0,
		classifiableCount: 0,
		classifyStackIds: [],
		...overrides
	} as unknown as PageData;
}

/** Every totals region on the page. Both breakpoints mount simultaneously (only CSS hides one),
 *  the long-standing duplication CLAUDE.md records for this page, so this returns two nodes and
 *  each assertion below checks all of them — a state fixed on one surface only is this repo's
 *  most-repeated defect shape. */
function totalsRegions(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll('[data-testid="filtered-totals"]')] as HTMLElement[];
}

describe('filtered-set totals: three states that do not resemble each other', () => {
	it('normal: writes both figures', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });

		const regions = totalsRegions(container);
		expect(regions).toHaveLength(2);
		for (const region of regions) {
			expect(region.textContent).toContain('120,00');
			expect(region.textContent).toContain('712,70');
			expect(region.textContent).not.toContain('—');
		}
	});

	it('true zero: writes 0,00 € rather than nothing at all', async () => {
		// The whole point of the state: the filter ran and the answer is zero, which is a FIGURE.
		// BREAK-THE-CHECK: restoring the `incomeCents > 0 || expenseCents > 0` gate empties the
		// region and this fails on the first `toContain` — verified by hand, see the PR report.
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({
				filteredTotals: { incomeCents: 0, expenseCents: 0 },
				pagination: { ...baseData().pagination, totalTransactions: 0 }
			}),
			form: null
		});

		for (const region of totalsRegions(container)) {
			expect(region.textContent).toContain('0,00');
			expect(region.textContent).toContain(m.transactions_totals_zero_label());
			expect(region.textContent).not.toContain('—');
		}
	});

	it.each([['queryError'], ['dateRangeError']])(
		'%s: writes — and says the totals are unavailable, never a figure',
		async (flag) => {
			await page.viewport(1280, 800);
			const { container } = render(Page, {
				data: baseData({
					[flag]: true,
					filteredTotals: { incomeCents: 0, expenseCents: 0 },
					pagination: { ...baseData().pagination, totalTransactions: 0 }
				}),
				form: null
			});

			for (const region of totalsRegions(container)) {
				expect(region.textContent).toContain('—');
				expect(region.textContent).toContain(m.transactions_totals_unavailable_label());
				// A zero here would be the original defect: an unrun query reported as an empty result.
				expect(region.textContent).not.toContain('0,00');
			}
		}
	);

	it('the error state never claims a transaction count, because none was computed', async () => {
		// The false claim this fixes: with the query rejected, the header still read "0 transaction,
		// page 1" and the list still read "Aucune transaction pour ces critères" — both asserting an
		// evaluated, empty result set. The server zeroes those fields precisely BECAUSE it has no
		// answer (+page.server.ts, the `queryError || dateRangeError` branch).
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({
				queryError: true,
				filteredTotals: { incomeCents: 0, expenseCents: 0 },
				pagination: { ...baseData().pagination, totalTransactions: 0 }
			}),
			form: null
		});

		expect(container.textContent).not.toContain(m.transactions_count_one({ count: 0, page: 1 }));
		expect(container.textContent).not.toContain(m.transactions_no_transactions_criteria());
		expect(container.textContent).not.toContain(m.transactions_empty_no_results_body());
		// ...and it says what did happen instead.
		expect(container.textContent).toContain(m.transactions_empty_query_error_title());
	});

	it('keeps ONE live region whose role never changes across the three states', async () => {
		// The design is explicit that the role must not be swapped mid-flight: "un élément qui
		// bascule status → alert n'est pas détecté de façon fiable par tous les lecteurs d'écran".
		// So the error is announced by its CONTENT ("Totaux indisponibles" first), not by escalating
		// politeness.
		await page.viewport(1280, 800);

		const seen = new Set<string>();
		for (const data of [
			baseData(),
			baseData({ filteredTotals: { incomeCents: 0, expenseCents: 0 } }),
			baseData({ queryError: true, filteredTotals: { incomeCents: 0, expenseCents: 0 } })
		]) {
			const view = render(Page, { data, form: null });
			for (const region of totalsRegions(view.container)) {
				seen.add(`${region.getAttribute('role')}|${region.getAttribute('aria-live')}`);
			}
			view.unmount();
		}

		expect([...seen]).toEqual(['status|polite']);
	});

	it('gives the error state the warning tone, never danger: nothing is broken for the user', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({ queryError: true, filteredTotals: { incomeCents: 0, expenseCents: 0 } }),
			form: null
		});

		for (const region of totalsRegions(container)) {
			// Tailwind v4's own amber-700, not a recomputation.
			expect(getComputedStyle(region).color).toBe('oklch(0.555 0.163 48.998)');
		}
	});
});
