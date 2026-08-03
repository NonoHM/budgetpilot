import { page } from 'vitest/browser';
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';
import { TRANSACTION_NATURES } from '$lib/domain/transaction';
import * as m from '$lib/paraglide/messages';

/**
 * The filter-bar grammar (design section 4).
 *
 * The rule: at rest a trigger carries the name of its DIMENSION and nothing else; active, it
 * carries "Dimension : Valeur" plus a separate × in an adjoined button group. "Toutes" is the
 * resting VALUE of a filter, and two triggers both displaying their resting value is what put two
 * adjacent "Toutes" in the bar. "Toutes" survives only as the return row inside an open list, and
 * on the nature segmented group — the one control that shows all its options at once, so the set
 * describes itself and the word is locally unambiguous there.
 *
 * Both filter surfaces render simultaneously at every viewport (a known, backlogged duplication),
 * so counts here are per-page and not per-surface unless stated.
 */

function baseData(overrides: Record<string, unknown> = {}): PageData {
	return {
		user: { email: 'test@example.com', role: 'USER' as const },
		transactions: [],
		selectedTransaction: null,
		selectedSuggestion: null,
		categoryOptions: ['Alimentation', 'Voyages'],
		categories: [
			{ name: 'Alimentation', defaultKey: null },
			{ name: 'Voyages', defaultKey: null }
		],
		allTags: [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }],
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
		...overrides
	};
}

describe('filter bar — trigger grammar', () => {
	it('at rest each trigger carries its dimension name', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		render(Page, { data: baseData(), form: null });

		await expect
			.element(
				page.getByRole('button', { name: m.transactions_filter_dimension_category() }).first()
			)
			.toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: m.tags_filter_dimension() }).first())
			.toBeInTheDocument();
	});

	it('no closed filter control opens with "Toutes" — only the nature group keeps the word', async () => {
		expect.assertions(1);
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });

		// Two earlier phrasings of this guard were incapable of failing, and the reason is worth
		// keeping: "no BUTTON named Toutes" missed it because the old control was a combobox, and
		// an EXACT match on "Toutes" missed it because the old controls displayed their
		// placeholders — "Toutes les catégories" and "Toutes les étiquettes". Two adjacent controls
		// both opening with that word IS the defect the grammar removes, so the guard has to look
		// at what every closed control displays, whatever element it is and whatever follows.
		const offenders = [...container.querySelectorAll('button, input')]
			.filter((el) => el.closest('[role="tab"]') === null)
			.map((el) =>
				el instanceof HTMLInputElement
					? (el.value || el.placeholder || '').trim()
					: (el.textContent ?? '').trim()
			)
			.filter((text) => text.startsWith(m.tags_filter_all()));

		expect(offenders).toEqual([]);
	});

	it('an active dimension reads "Dimension : Valeur" and grows its own clear control', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		render(Page, {
			data: baseData({ filters: { ...baseData().filters, tag: 'tag-1' } }),
			form: null
		});

		const active = m.transactions_filter_active_trigger({
			dimension: m.tags_filter_dimension(),
			value: 'Portugal'
		});
		await expect.element(page.getByRole('button', { name: active }).first()).toBeInTheDocument();
		// Two adjoined buttons, so the filter can be re-chosen without clearing it first.
		await expect
			.element(
				page
					.getByRole('button', {
						name: m.transactions_filter_clear_aria({ dimension: m.tags_filter_dimension() })
					})
					.first()
			)
			.toBeInTheDocument();
	});

	it('the tag dimension keeps its tint when active, and the category dimension does not', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		render(Page, {
			data: baseData({
				filters: { ...baseData().filters, tag: 'tag-1', category: 'Voyages' }
			}),
			form: null
		});

		// The one place in the bar where a tag's identity shows, and the only tinted surface here.
		// Subordinated, not decorative: same height, radius, word order and × position as the
		// neutral grammar, only the background and border colour differ.
		const tagGroup = page
			.getByRole('button', {
				name: m.transactions_filter_active_trigger({
					dimension: m.tags_filter_dimension(),
					value: 'Portugal'
				})
			})
			.first()
			.element().parentElement;
		const categoryGroup = page
			.getByRole('button', {
				name: m.transactions_filter_active_trigger({
					dimension: m.transactions_filter_dimension_category(),
					value: 'Voyages'
				})
			})
			.first()
			.element().parentElement;

		expect(tagGroup?.className).not.toContain('border-zinc-900');
		expect(categoryGroup?.className).toContain('border-zinc-900');
	});

	it('a tag id that no longer names a tag renders as resting, not half-active', async () => {
		expect.assertions(2);
		// Reachable rather than theoretical: a tag on zero transactions is deleted silently, so a
		// bookmarked ?tag=<id> outlives its tag. The way out is the summary row's reset, which is
		// rendered because the server still counts the filter as active.
		await page.viewport(1280, 800);
		render(Page, {
			data: baseData({ filters: { ...baseData().filters, tag: 'deleted-id' } }),
			form: null
		});

		await expect
			.element(page.getByRole('button', { name: m.tags_filter_dimension() }).first())
			.toBeInTheDocument();
		expect(
			page
				.getByRole('button', {
					name: m.transactions_filter_clear_aria({ dimension: m.tags_filter_dimension() })
				})
				.elements().length
		).toBe(0);
	});
});
