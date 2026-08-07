import { page, userEvent } from 'vitest/browser';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';
import { TRANSACTION_NATURES } from '$lib/domain/transaction';
import * as m from '$lib/paraglide/messages';

const goto = vi.hoisted(() => vi.fn());
// Spread the real module rather than replacing it: `$app/forms`' enhance imports `invalidateAll`
// from here, so a bare `{ goto }` factory fails the whole file at import time.
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto
}));

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
			tag: '',
			split: 'all'
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

/**
 * Mobile — the filter sheet and the tag sub-sheet (design section 6).
 *
 * Category and tag collapse behind a "Filtres" trigger instead of the desktop's two side-by-side
 * dropdowns; the SAME grammar and the SAME `applyFilterDimension`/`tagFilterOptions` deriveds
 * drive both surfaces, only the pixels differ. `page.viewport(390, 844)` matters here beyond
 * picking a screen size: `lg:hidden`/`hidden lg:block` are real CSS, evaluated in a real browser
 * by vitest-browser-svelte, so ROLE queries (which respect `display: none` when computing the
 * accessibility tree) already return only the surface the viewport shows — unlike the TEXT
 * queries `bulk-tag.svelte.spec.ts` uses, which see both copies and need an explicit count of 2.
 * That is verified directly in the first case below rather than assumed.
 */
describe('filter bar — mobile sheet', () => {
	// Cleared per test, not once inside the one test that counts calls. The mock is module-level and
	// every mount in this file shares it, so a navigation started by an earlier test can still be
	// resolving when the next one begins — which is exactly how the count assertion below went red
	// once in five runs and green the other four.
	beforeEach(() => goto.mockClear());

	it('at rest the trigger reads plainly "Filtres", and only the mobile copy is in the accessibility tree at this viewport', async () => {
		expect.assertions(2);
		await page.viewport(390, 844);
		render(Page, { data: baseData(), form: null });

		const trigger = page.getByRole('button', { name: m.transactions_filters_sheet_label() });
		await expect.element(trigger.first()).toBeInTheDocument();
		// Confirms the premise the rest of this describe block relies on: a ROLE query at the
		// mobile viewport does not also pick up a desktop element under the same accessible name
		// (there is none here, but this is the guard that the premise itself is true, not assumed).
		expect(trigger.elements().length).toBe(1);
	});

	it('with one active dimension the trigger reads "Filtres, 1 actif" and an active token with its own clear control appears', async () => {
		expect.assertions(2);
		await page.viewport(390, 844);
		render(Page, {
			data: baseData({ filters: { ...baseData().filters, category: 'Voyages' } }),
			form: null
		});

		await expect
			.element(
				page
					.getByRole('button', {
						name: m.transactions_filters_sheet_aria_one({ count: 1 })
					})
					.first()
			)
			.toBeInTheDocument();
		await expect
			.element(
				page
					.getByRole('button', {
						name: m.transactions_filter_clear_aria({
							dimension: m.transactions_filter_dimension_category()
						})
					})
					.first()
			)
			.toBeInTheDocument();
	});

	it('with category AND tag active the trigger reads "Filtres, 2 actifs" — the design\'s own example', async () => {
		expect.assertions(1);
		await page.viewport(390, 844);
		render(Page, {
			data: baseData({
				filters: { ...baseData().filters, category: 'Voyages', tag: 'tag-1' }
			}),
			form: null
		});

		await expect
			.element(
				page
					.getByRole('button', {
						name: m.transactions_filters_sheet_aria_many({ count: 2 })
					})
					.first()
			)
			.toBeInTheDocument();
	});

	it('opening the sheet shows both dimensions at rest as "Toutes", and the apply button names the current total', async () => {
		expect.assertions(3);
		await page.viewport(390, 844);
		render(Page, {
			data: baseData({
				pagination: { ...baseData().pagination, totalTransactions: 6 }
			}),
			form: null
		});

		await userEvent.click(page.getByRole('button', { name: m.transactions_filters_sheet_label() }));

		// The row's accessible name concatenates its 12px dimension label and its value ("Catégorie
		// Toutes"), which is the vertical form of "Dimension : Valeur" minus the colon — so it is
		// matched by the dimension name and its "Toutes" value is read off its own text content
		// rather than by an exact accessible-name equality that the concatenation would fail.
		// `.last()`, not `.first()`: the always-visible dimension pill above the sheet ALSO matches
		// this regex (its resting name is the bare dimension name), and it renders before the
		// sheet's own row in DOM order.
		const categoryRow = page
			.getByRole('button', { name: new RegExp(m.transactions_filter_dimension_category()) })
			.last();
		await expect.element(categoryRow).toBeInTheDocument();
		expect(categoryRow.element().textContent).toContain(m.transactions_category_filter_all());
		await expect
			.element(
				page.getByRole('button', { name: m.transactions_filters_sheet_apply_many({ count: 6 }) })
			)
			.toBeInTheDocument();
	});

	it('the category sub-sheet lists options with a check on the current selection, and picking one navigates', async () => {
		expect.assertions(2);
		await page.viewport(390, 844);
		render(Page, {
			data: baseData({ filters: { ...baseData().filters, category: 'Alimentation' } }),
			form: null
		});

		await userEvent.click(page.getByRole('button', { name: m.transactions_filters_sheet_label() }));
		// Exact match, not the dimension-name regex the previous test uses: with a category already
		// active, the mobile block also renders "Catégorie : Alimentation" (the token) and "Retirer
		// le filtre par Catégorie" (its clear button), both of which contain "Catégorie" too. The
		// sheet ROW's full accessible name is its own two-line text, "Catégorie" + "Alimentation".
		await userEvent.click(
			page.getByRole('button', {
				name: `${m.transactions_filter_dimension_category()} Alimentation`
			})
		);
		await userEvent.click(page.getByRole('button', { name: 'Voyages' }));

		// Filtered to the navigations this gesture is responsible for, so a stray call from anywhere
		// else cannot decide the result. ONE of them: picking an option must not navigate twice.
		const categoryNavigations = goto.mock.calls
			.map((call) => String(call[0]))
			.filter((href) => href.includes('category='));
		expect(categoryNavigations).toHaveLength(1);
		expect(categoryNavigations[0]).toContain('category=Voyages');
	});

	it('the tag sub-sheet renders a zero-count row dimmed but reachable, never hidden', async () => {
		expect.assertions(2);
		await page.viewport(390, 844);
		render(Page, {
			data: baseData({
				tagCounts: [{ tagId: 'tag-1', count: 0 }],
				tagScopeTotal: 0
			}),
			form: null
		});

		// Direct access, not via "Filtres": the always-visible tag pill opens its own sub-sheet on
		// its own, and at rest (no tag active) its accessible name is the bare dimension name, so an
		// exact match is unambiguous here.
		await userEvent.click(page.getByRole('button', { name: m.tags_filter_dimension() }));

		const row = page.getByRole('button', { name: /Portugal/ }).first();
		await expect.element(row).toBeInTheDocument();
		expect(row.element().getAttribute('aria-disabled')).toBe('true');
	});

	it('every mobile filter control clears the 44px floor, in both the resting and the active state', async () => {
		expect.assertions(3);
		await page.viewport(390, 844);

		// MEASURED on the rendered controls, in both states, because the active state is where the
		// floor was breached: the pills adopt a second adjoined button ("×") whose height comes from
		// the wrapper, so a wrapper sized for the resting label silently under-sizes two targets at
		// once. First measured at 36px for "Filtres" and 34px for each pill and its clear control.
		const mobileButtons = (c: HTMLElement) =>
			[...c.querySelectorAll<HTMLElement>('.lg\\:hidden button')].filter(
				(b) => b.offsetParent !== null
			);
		const shortest = (c: HTMLElement) =>
			Math.min(...mobileButtons(c).map((b) => Math.round(b.getBoundingClientRect().height)));

		const resting = render(Page, { data: baseData(), form: null });
		expect(shortest(resting.container)).toBeGreaterThanOrEqual(44);

		const active = render(Page, {
			data: baseData({
				filters: { ...baseData().filters, category: 'Alimentation', tag: 'tag-1' }
			}),
			form: null
		});
		// The active state renders strictly MORE controls than the resting one — each pill gains its
		// adjoined "×". Asserting that count first is what stops the measurement below passing
		// vacuously against a state where the clear buttons never rendered at all: shrinking one to
		// 34px then goes red here, which it did not when only the minimum was checked. Note the
		// adjoined "×" takes its height from `items-stretch` on the wrapper, so the LABEL button is
		// what actually sets the row: breaking that one is what turns this red, and breaking the "×"
		// alone cannot, because it stretches. Both were tried.
		expect(mobileButtons(active.container).length).toBeGreaterThan(
			mobileButtons(resting.container).length
		);
		expect(shortest(active.container)).toBeGreaterThanOrEqual(44);
	});

	it('all four mobile filter-bar triggers draw at the 12px referential radius (design 6I)', async () => {
		expect.assertions(4);
		await page.viewport(390, 844);
		const { container } = render(Page, {
			data: baseData({
				filters: { ...baseData().filters, category: 'Alimentation', tag: 'tag-1' }
			}),
			form: null
		});

		// MEASURED, not read off a class list: rounded-lg (8px) and rounded-xl (12px) both compile,
		// and only getComputedStyle distinguishes which one actually reached the rendered node.
		const radiusOf = (el: HTMLElement) => getComputedStyle(el).borderTopLeftRadius;

		const filtresTrigger = page
			.getByRole('button', { name: m.transactions_filters_sheet_aria_many({ count: 2 }) })
			.element() as HTMLElement;
		expect(radiusOf(filtresTrigger)).toBe('12px');

		// Catégorie and Étiquette are groups of two adjoined buttons: the radius lives on the
		// wrapping <span> (`overflow-hidden`), which is what actually clips the corner — not on
		// either button. The button is the wrapper's direct child, same convention this file already
		// uses at line ~164 for the desktop group (`.parentElement`, not a CSS `closest` search).
		const categoryButton = page
			.getByRole('button', {
				name: m.transactions_filter_active_trigger({
					dimension: m.transactions_filter_dimension_category(),
					value: 'Alimentation'
				})
			})
			.element() as HTMLElement;
		expect(radiusOf(categoryButton.parentElement!)).toBe('12px');

		const tagButton = page
			.getByRole('button', {
				name: m.transactions_filter_active_trigger({
					dimension: m.tags_filter_dimension(),
					value: 'Portugal'
				})
			})
			.element() as HTMLElement;
		expect(radiusOf(tagButton.parentElement!)).toBe('12px');

		// Période — the referential the other three were brought up to. Already conformant before
		// this change; asserted here too so a regression on any of the four is caught in one place.
		// `getByTestId` ignores `display: none`, unlike a role query — both the hidden desktop copy
		// and the mobile one carry `data-testid="period-trigger-group"`, so this scopes to the
		// `.lg\:hidden` subtree the same way `mobileButtons()` above does, rather than the role-query
		// exclusion this file otherwise relies on.
		const periodGroup = container.querySelector(
			'.lg\\:hidden [data-testid="period-trigger-group"]'
		) as HTMLElement;
		expect(radiusOf(periodGroup)).toBe('12px');
	});
});

/**
 * Période (design section 5): the composite dimension that replaces the two native
 * `type="date"` inputs. Full ladder/preset coverage lives in `periodLabel.spec.ts` and
 * `PeriodFilter.svelte.spec.ts`; these cases are only about wiring the component into the page.
 */
describe('filter bar — Période dimension', () => {
	it('renders no native date input anywhere on the page', async () => {
		expect.assertions(1);
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });

		// The defect this dimension closes: type="date" renders jj/mm/aaaa or mm/dd/yyyy depending
		// on the BROWSER's own locale and ignores every lang attribute the app can set, so the same
		// build showed two different formats on two machines.
		expect(container.querySelectorAll('input[type="date"]')).toHaveLength(0);
	});

	it('places Période in the bar with the same grammar as the other dimensions', async () => {
		expect.assertions(1);
		await page.viewport(1280, 800);
		render(Page, { data: baseData(), form: null });

		await expect
			.element(page.getByRole('button', { name: m.transactions_filter_dimension_period() }).first())
			.toBeInTheDocument();
	});

	it('renders the invalid range neutrally, with no destructive or overdue tone', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({
				dateRangeError: true,
				filters: { ...baseData().filters, from: 'nonsense', to: '2026-06-12' }
			}),
			form: null
		});

		const group = container.querySelector('[data-testid="period-trigger-group"]');
		expect(group?.className).not.toMatch(/rose|amber/);
		expect(container.textContent).toContain('invalide');
	});

	it('stops the mobile ladder at the numeric rung: no "période personnalisée" at 390', async () => {
		expect.assertions(1);
		await page.viewport(390, 844);
		const { container } = render(Page, {
			data: baseData({
				filters: { ...baseData().filters, from: '2026-09-30', to: '2027-02-28' }
			}),
			form: null
		});

		// The mobile caller passes `allowCustomRung={false}`: touch has no hover, so a Tooltip-backed
		// rung is not recoverable and this rung must never be reachable at 390.
		const mobile = container.querySelector('.lg\\:hidden');
		expect(mobile?.textContent).not.toContain(m.transactions_period_custom());
	});
});

describe('filter bar — the search field', () => {
	it('desktop: the regex toggle is inside the search field, and the field holds the right edge', async () => {
		expect.assertions(4);
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });

		const bar = container.querySelector<HTMLElement>('div.hidden.lg\\:block')!;
		const field = bar.querySelector<HTMLInputElement>('input[name="q"]')!;
		const toggle = [...bar.querySelectorAll<HTMLElement>('button')].find((b) =>
			(b.getAttribute('aria-label') ?? '').includes(m.transactions_regex_toggle_aria())
		)!;

		// Section 7's actual point, and the half that shipped wrong first: a character in a bordered
		// box is a button, a character BESIDE a field is a typo. Containment, not proximity —
		// measured as DOM ancestry, since "close to the field" is what the defect already looked like.
		expect(field.parentElement!.contains(toggle)).toBe(true);
		// And inside its right edge, not overlapping the text.
		const f = field.getBoundingClientRect();
		const t = toggle.getBoundingClientRect();
		expect(Math.round(t.right)).toBeLessThanOrEqual(Math.round(f.right));
		expect(Math.round(t.left)).toBeGreaterThan(Math.round(f.left));

		// The field takes the RIGHT END of the bar, and this is measured against the bar's own edge
		// rather than against the triggers. "Every trigger is to its left" is satisfied by DOM order
		// alone — swapping `ml-auto` for `mr-auto` leaves it green while the field sits mid-row —
		// so the assertion has to be about where the field actually lands.
		const row = field.closest('form')!.getBoundingClientRect();
		expect(Math.round(row.right - f.right)).toBeLessThanOrEqual(96);
	});
});
