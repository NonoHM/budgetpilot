import { page } from 'vitest/browser';
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';
import { TRANSACTION_NATURES } from '$lib/domain/transaction';
import * as m from '$lib/paraglide/messages';
import { formatCents } from '$lib/domain/budget';
import { MAX_BULK_TAG_TRANSACTIONS } from '$lib/domain/tags';

/**
 * The summary row (design sections 5 and 8).
 *
 * Two rows, one function each: you filter above, you read what the filter gave and act on it
 * below. The row is ALWAYS rendered — it carries the totals, which a user has today with no filter
 * at all and must not lose. Only "Réinitialiser les filtres" and the bulk trigger are conditional.
 * That is a correction after arbitration: making the row itself conditional would have removed the
 * amounts from the unfiltered view.
 *
 * The bulk trigger descends into this row, against the wall of the number defining its scope.
 * Placed among four filter controls it read as a fifth filter.
 */

function baseData(overrides: Record<string, unknown> = {}): PageData {
	return {
		user: { email: 'test@example.com', role: 'USER' as const },
		transactions: [],
		selectedTransaction: null,
		selectedSuggestion: null,
		categoryOptions: ['Voyages'],
		splitCategoryOptions: [],
		categories: [{ id: 'cat-voyages', name: 'Voyages' }],
		allTags: [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }],
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
		filteredTotals: { incomeCents: 426000, expenseCents: 341890 },
		queryError: false,
		dateRangeError: false,
		pagination: {
			page: 1,
			pageSize: 25,
			totalTransactions: 142,
			totalPages: 6,
			hasPrevious: false,
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

/** A filtered state: one dimension active, six results. */
function filtered(overrides: Record<string, unknown> = {}) {
	const base = baseData();
	return baseData({
		filters: { ...base.filters, category: 'Voyages' },
		pagination: { ...base.pagination, totalTransactions: 6, totalPages: 1, hasNext: false },
		...overrides
	});
}

function summaryRegions(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>('[data-testid="filtered-totals"]')];
}

function bulkTriggers(container: HTMLElement): HTMLButtonElement[] {
	return [...container.querySelectorAll<HTMLButtonElement>('[data-testid="bulk-tag-trigger"]')];
}

describe('summary row', () => {
	it('is rendered with no filter at all, carrying the totals a user has today', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });

		// Both surfaces render simultaneously, a known duplication: a count of 2 is what stops this
		// passing while one of the two has lost its totals.
		expect(summaryRegions(container)).toHaveLength(2);
		// EXACT text, not a substring. The old count read "142 transactions, page 1", which
		// contains "142 transactions" — so a substring assertion could not tell the new wording
		// from the one it replaces, and passed against the unmodified page.
		expect(
			[...container.querySelectorAll('[data-testid="summary-count"]')].map((el) =>
				el.textContent?.trim()
			)
		).toEqual([
			m.transactions_total_many({ count: 142 }),
			m.transactions_total_many({ count: 142 })
		]);
	});

	it('names the whole month without a filter, and results with one', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);

		const countText = (c: HTMLElement) =>
			c.querySelector('[data-testid="summary-count"]')?.textContent?.trim();

		const unfiltered = render(Page, { data: baseData(), form: null });
		// "142 transactions" — the whole month, not a result.
		expect(countText(unfiltered.container)).toBe(m.transactions_total_many({ count: 142 }));
		unfiltered.unmount();

		const withFilter = render(Page, { data: filtered(), form: null });
		// "6 résultats". One word per concept: the bar said "6 transactions filtrées" here and
		// "Étiqueter les 6 résultats" on the trigger, naming one thing two ways.
		expect(countText(withFilter.container)).toBe(m.transactions_results_many({ count: 6 }));
	});

	it('withholds both conditional controls until a filter is active', async () => {
		expect.assertions(4);
		await page.viewport(1280, 800);

		const unfiltered = render(Page, { data: baseData(), form: null });
		expect(bulkTriggers(unfiltered.container)).toHaveLength(0);
		expect(unfiltered.container.querySelectorAll('[data-testid="reset-filters"]')).toHaveLength(0);
		unfiltered.unmount();

		const withFilter = render(Page, { data: filtered(), form: null });
		expect(bulkTriggers(withFilter.container)).toHaveLength(2);
		expect(withFilter.container.querySelectorAll('[data-testid="reset-filters"]')).toHaveLength(2);
	});

	it('keeps every button out of the live region', async () => {
		expect.assertions(1);
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: filtered(), form: null });

		// role="status" covers the TEXT only. With the controls inside it, every filter change
		// re-announces "Réinitialiser les filtres, bouton" alongside the figures.
		const withButtons = summaryRegions(container).filter(
			(region) => region.querySelector('button, a') !== null
		);
		expect(withButtons).toEqual([]);
	});

	it('zero results: the trigger stays focusable, drops the number, and explains itself', async () => {
		expect.assertions(4);
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: filtered({
				pagination: {
					page: 1,
					pageSize: 25,
					totalTransactions: 0,
					totalPages: 1,
					hasPrevious: false,
					hasNext: false
				}
			}),
			form: null
		});

		const trigger = bulkTriggers(container)[0];
		// aria-disabled rather than disabled, so Tab reaches it and the explanation is heard. BOTH
		// halves asserted: the identical defect was fixed once on this trigger and survived two more
		// PRs on the tags editor's Save button, because the report named one line instead of a shape.
		expect(trigger.getAttribute('aria-disabled')).toBe('true');
		expect(trigger.disabled).toBe(false);
		// The locked label without its number: there is no number to say.
		expect(trigger.textContent?.trim()).toBe(m.tags_bulk_cta_disabled());
		const describedBy = trigger.getAttribute('aria-describedby');
		expect(describedBy && container.querySelector(`#${describedBy}`)).toBeTruthy();
	});

	it('no tag exists yet: the trigger is still rendered, disabled, naming the only way to create one', async () => {
		expect.assertions(3);
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: filtered({ allTags: [] }), form: null });

		// Deliberately unlike the tag FILTER, which is not rendered at all in this case. A filter
		// with no possible value has nothing to offer; an unavailable ACTION has to teach the
		// condition under which it becomes available.
		const trigger = bulkTriggers(container)[0];
		expect(trigger).toBeTruthy();
		expect(trigger.getAttribute('aria-disabled')).toBe('true');
		expect(container.textContent).toContain(m.tags_bulk_cta_no_tags_hint());
	});

	it('over the cap: the refusal is a warning up front, naming a fallback with its real count', async () => {
		expect.assertions(4);
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: filtered({
				pagination: {
					page: 1,
					pageSize: 25,
					totalTransactions: 312,
					totalPages: 13,
					hasPrevious: false,
					hasNext: true
				},
				bulkFallback: { kind: 'expense', count: 186 }
			}),
			form: null
		});

		// Amber, not rose, and OUTSIDE the dialog: the cap is not something the user broke, and a
		// refusal only reachable by opening a dialog is a refusal the user meets too late.
		const banners = [...container.querySelectorAll('[role="alert"]')].filter((el) =>
			el.textContent?.includes(m.tags_bulk_over_limit_body())
		);
		expect(banners).toHaveLength(2);
		expect(banners[0].className).toContain('amber');
		// The REAL count, so the user sees which narrowing passes before clicking anything.
		expect(banners[0].textContent).toContain(
			m.tags_bulk_over_limit_fallback_expense({ count: 186 })
		);
		expect(banners[0].querySelector(`a`)?.textContent?.trim()).toBe(
			m.tags_bulk_over_limit_action()
		);
	});

	it('over the cap with nothing that would fit: the banner offers no route at all', async () => {
		expect.assertions(3);
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: filtered({
				pagination: {
					page: 1,
					pageSize: 25,
					totalTransactions: 312,
					totalPages: 13,
					hasPrevious: false,
					hasNext: true
				},
				bulkFallback: null
			}),
			form: null
		});

		const banners = [...container.querySelectorAll('[role="alert"]')].filter((el) =>
			el.textContent?.includes(m.tags_bulk_over_limit_body())
		);
		expect(banners).toHaveLength(2);
		// Present, and silent about routes. Proposing one that cannot help is the /upcoming-bills
		// defect closed in #99 — worse here, because it would name a number the user can check.
		expect(banners[0].textContent).not.toContain(m.tags_bulk_over_limit_action());
		expect(banners[0].querySelector('a')).toBeNull();
	});

	it('under the cap: no refusal at all', async () => {
		expect.assertions(1);
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: filtered({
				pagination: {
					page: 1,
					pageSize: 25,
					totalTransactions: MAX_BULK_TAG_TRANSACTIONS,
					totalPages: 10,
					hasPrevious: false,
					hasNext: false
				}
			}),
			form: null
		});

		// Exactly AT the cap, not comfortably under it: the boundary is where an off-by-one lives.
		expect(container.textContent).not.toContain(m.tags_bulk_over_limit_body());
	});

	/** One row, so the table exists to measure the band against. */
	const ONE_ROW = [
		{
			id: 'tx-1',
			date: '2026-06-22',
			label: 'Restaurante Adega',
			amountCents: -5210,
			type: 'expense' as const,
			category: 'Voyages',
			importedCategory: 'Voyages',
			manualCategory: null,
			isManualCategory: false,
			nature: 'spending' as const,
			manualNature: null,
			natureSource: 'category' as const,
			source: 'manual' as const,
			suggestion: null,
			tags: []
		}
	];

	it('desktop: the band is its own row above the table, and reads on one line', async () => {
		expect.assertions(6);
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData({ transactions: ONE_ROW }), form: null });

		const band = container.querySelector<HTMLElement>('[data-testid="summary-band"]')!;
		const table = container.querySelector<HTMLElement>('table')!;
		expect(band).toBeTruthy();
		// OUTSIDE the table's card, not inside its header: "two rows, one function each". It shipped
		// inside the pagination header, which is why the band the design specifies did not exist.
		expect(band.contains(table)).toBe(false);
		expect(table.closest('section')!.contains(band)).toBe(false);
		expect(Math.round(band.getBoundingClientRect().bottom)).toBeLessThanOrEqual(
			Math.round(table.getBoundingClientRect().top)
		);

		// ONE line: side by side, vertically overlapping. NOT equal `top` — the two carry different
		// font sizes and are baseline-aligned, so their boxes legitimately start 3px apart, and an
		// equality would be asserting the font sizes rather than the layout. What the stacked version
		// actually violated is that the totals sat BELOW the count at the same left edge.
		const count = band
			.querySelector<HTMLElement>('[data-testid="summary-count"]')!
			.getBoundingClientRect();
		const totals = band
			.querySelector<HTMLElement>('[data-testid="filtered-totals"]')!
			.getBoundingClientRect();
		expect(totals.left).toBeGreaterThan(count.right);
		expect(Math.min(count.bottom, totals.bottom) - Math.max(count.top, totals.top)).toBeGreaterThan(
			0
		);
	});

	it('labels each figure and signs it, expenses first', async () => {
		expect.assertions(5);
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });

		const totals = container.querySelector<HTMLElement>('[data-testid="filtered-totals"]')!;
		// Whitespace normalised on BOTH sides, never on one: Intl separates thousands with U+202F
		// (narrow no-break space), so an expectation built from a plain space silently never matches
		// — the trap CLAUDE.md already records for a `0,00 €` assertion.
		const norm = (v: string) => v.replace(/\s+/g, ' ').trim();
		const text = norm(totals.textContent!);

		// "Dépenses −3 418,90 €   Revenus +4 260,00 €": label first so a reader scanning a column of
		// figures finds the word before the number, and SIGNED so the direction is readable without
		// the word. It shipped as "42,50 € encaissés · 1 402,66 € dépensés" — value first, unsigned.
		expect(text).toContain(m.transactions_totals_expense_label());
		expect(text).toContain(m.transactions_totals_income_label());
		expect(text.indexOf(m.transactions_totals_expense_label())).toBeLessThan(
			text.indexOf(m.transactions_totals_income_label())
		);
		// BOTH signed, and by Intl rather than by concatenation — Intl owns the glyph and the side.
		// Asserted as the exact rendered strings, so a hand-pasted "+" in front of an unsigned value
		// cannot satisfy it.
		expect(text).toContain(norm(formatCents(-341890, undefined, undefined, 'exceptZero')));
		expect(text).toContain(norm(formatCents(426000, undefined, undefined, 'exceptZero')));
	});
});
