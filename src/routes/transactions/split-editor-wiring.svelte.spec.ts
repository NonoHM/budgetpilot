import { page, userEvent } from 'vitest/browser';
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { ActionData, PageData } from './$types';
import { TRANSACTION_NATURES, type TransactionNature } from '$lib/domain/transaction';
// Compared against the message FUNCTION, never a retyped literal — this file's neighbour
// `page.server.spec.ts` states the rule and the reason: a spec that copies the sentence passes
// while the catalogue says something else. `splitsError` is a branded `LocalizedString`, so here
// the type system enforces it rather than merely recommending it.
import * as m from '$lib/paraglide/messages';

/**
 * The editor's two mount points and the door into them (design 1b, 1j).
 *
 * The component specs beside `SplitEditor.svelte` prove the editor's own mechanics. Nothing there
 * can see the wiring: whether a door exists, whether the parent selector it locks is the one on the
 * SAME surface, whether the two simultaneous mounts point at each other's explanation. Those are
 * page facts, and the last of them is the one this page has been caught by before — `hintId` in
 * `TransactionTagsEditor` exists because two concurrent mounts resolved to whichever id the DOM
 * found first.
 */

const SPENDING: TransactionNature = 'spending';

const CATEGORY_OPTIONS = [
	{ value: 'cat-alimentation', label: 'Alimentation' },
	{ value: 'cat-maison', label: 'Maison' }
];

const SPLIT_60_20 = [
	{ categoryId: 'cat-alimentation', amountCents: -6_000, note: '' },
	{ categoryId: 'cat-maison', amountCents: -2_000, note: '' }
];

function baseData(selectedOverrides: Record<string, unknown> = {}): PageData {
	return {
		user: { email: 'test@example.com', role: 'USER' as const },
		transactions: [
			{
				id: 'tx-1',
				date: '2026-06-24',
				label: 'Carrefour Market',
				category: 'Alimentation',
				importedCategory: 'Alimentation',
				manualCategory: null,
				isManualCategory: false,
				nature: SPENDING,
				natureSource: 'category' as const,
				manualNature: null,
				amountCents: -8_000,
				type: 'expense' as const,
				source: 'banque_populaire',
				tags: [],
				suggestion: null
			}
		],
		selectedTransaction: {
			id: 'tx-1',
			date: '2026-06-24',
			label: 'Carrefour Market',
			amountCents: -8_000,
			type: 'expense' as const,
			category: 'Alimentation',
			importedCategory: 'Alimentation',
			manualCategory: null,
			isManualCategory: false,
			nature: SPENDING,
			natureSource: 'category' as const,
			manualNature: null,
			source: 'banque_populaire',
			notes: null,
			reference: null,
			dedupeKey: null,
			createdAt: '2026-06-24T10:00:00.000Z',
			updatedAt: '2026-06-24T10:00:00.000Z',
			account: null,
			importBatch: null,
			bankFields: [],
			bankOperationType: null,
			subcategory: '',
			tags: [],
			splits: [],
			splitInheritCategoryId: 'cat-alimentation',
			splitEntryAvailable: true,
			...selectedOverrides
		},
		selectedSuggestion: null,
		categoryOptions: ['Alimentation', 'Maison'],
		splitCategoryOptions: CATEGORY_OPTIONS,
		categories: [
			{ id: 'cat-alimentation', name: 'Alimentation', defaultKey: null },
			{ id: 'cat-maison', name: 'Maison', defaultKey: null }
		],
		allTags: [],
		natureOptions: TRANSACTION_NATURES,
		splitFilterAvailable: false,
		splitCounts: null,
		filters: {
			q: '',
			qMode: 'contains' as const,
			type: 'all' as const,
			category: 'all',
			from: '',
			to: '',
			importBatchId: 'all',
			ids: '',
			tag: 'all',
			split: 'all'
		},
		importBatches: [],
		rules: [],
		filteredTotals: { incomeCents: 0, expenseCents: 8_000 },
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
		todayIso: '2026-06-24'
	} as unknown as PageData;
}

/**
 * One action result, as the page's `form` prop.
 *
 * Cast, and the reason is worth stating rather than hiding: `ActionData` is a ~20-member union and
 * TypeScript's excess-property check picks ONE best-matching member, so a shape the server really
 * does return — `{ splitsError, splitsPositions }` from the amount refusal — is rejected against a
 * sibling member that happens to match on `splitsError` alone. The sentences themselves still come
 * from the message functions, so catalogue drift is caught where it matters.
 */
function actionResult(fields: Record<string, unknown>): ActionData {
	return fields as ActionData;
}

/** The desktop `<aside>`, which is the only surface visible at 1280. */
function aside(container: HTMLElement) {
	return container.querySelector('aside') as HTMLElement;
}

/** The mobile sheet, located by ROLE rather than by class list — the class list is exactly what a
 *  geometry or structure assertion must not trust. */
function sheet() {
	return page.getByRole('dialog', { name: 'Carrefour Market' }).element() as HTMLElement;
}

describe('the entry point (1b)', () => {
	it('desktop: the door exists, and pressing it is what puts the editor on screen', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });
		const panel = aside(container);

		// The editor is ABSENT first and appears on the gesture. Asserting the open state alone
		// would pass on a page that renders the editor unconditionally, which is the one thing 1b
		// is about.
		expect(panel.querySelector('fieldset legend')?.textContent?.trim()).not.toBe('Répartition');

		const entry = panel.querySelector(
			'button[type="button"]:not([aria-label])'
		) as HTMLButtonElement | null;
		const door = Array.from(panel.querySelectorAll('button')).find((b) =>
			b.textContent?.includes('Répartir entre plusieurs catégories')
		) as HTMLButtonElement;
		expect(door).toBeTruthy();
		expect(entry).toBeTruthy();

		// 44px, « pas un lien de 20 px : c'est une action, elle a la hauteur des actions ». Measured,
		// not read off the class list.
		expect(door.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);

		await userEvent.click(door);
		const legends = Array.from(panel.querySelectorAll('legend')).map((l) => l.textContent?.trim());
		expect(legends).toContain('Répartition');
	});

	it('is withheld exactly when the load says so, on both surfaces at once', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({ splitEntryAvailable: false }),
			form: null
		});

		const doors = Array.from(container.querySelectorAll('button')).filter((b) =>
			b.textContent?.includes('Répartir entre plusieurs catégories')
		);
		// BOTH mounts render into the DOM simultaneously on this page, so a check that found one
		// door would say nothing about the other. Zero is the assertion.
		expect(doors.length).toBe(0);
	});

	it('renders one door per surface, and both are in the DOM at once — so neither can be forgotten', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });

		const doors = Array.from(container.querySelectorAll('button')).filter((b) =>
			b.textContent?.includes('Répartir entre plusieurs catégories')
		);
		expect(doors.length).toBe(2);
	});
});

describe('the parent selector locks in situ (1j, 1q)', () => {
	it('is aria-disabled and points at the sentence ON ITS OWN SURFACE, never the other mount’s', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({ splits: SPLIT_60_20, splitEntryAvailable: false }),
			form: null
		});

		const selectors = Array.from(
			container.querySelectorAll<HTMLInputElement>('input[aria-label="Catégorie manuelle"]')
		);
		expect(selectors.length).toBe(2);

		const describedBy = selectors.map((el) => el.getAttribute('aria-describedby'));
		expect(describedBy.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
		// The gotcha this page already learned once, generalised: two concurrent mounts must not
		// resolve to the same explanation, or a screen reader on either surface reads whichever the
		// DOM found first and the two can never disagree loudly enough to be noticed.
		expect(new Set(describedBy).size).toBe(2);

		for (const el of selectors) {
			expect(el.getAttribute('aria-disabled')).toBe('true');
			expect(el.hasAttribute('disabled')).toBe(false);

			const sentence = container.querySelector(
				`#${CSS.escape(el.getAttribute('aria-describedby')!)}`
			);
			expect(sentence?.textContent?.trim()).toBe(m.splits_parent_locked());
			// 1p's law, and the reason the band is not the target anywhere in this feature: an
			// aria-hidden element takes its descendants out of the accessibility tree, so a
			// describedby pointed inside one exposes nothing reliable.
			expect(sentence?.closest('[aria-hidden="true"]')).toBeNull();
		}
	});

	it('withholds « Réinitialiser », because it writes the very category the lock forbids', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({
				manualCategory: 'Alimentation',
				isManualCategory: true,
				splits: SPLIT_60_20,
				splitEntryAvailable: false
			}),
			form: null
		});

		const resets = Array.from(container.querySelectorAll('button')).filter(
			(b) => b.textContent?.trim() === 'Réinitialiser'
		);
		expect(resets.length).toBe(0);
	});

	it('leaves the selector live when nothing is répartie — proven by opening its list', async () => {
		await page.viewport(1280, 800);
		render(Page, { data: baseData(), form: null });

		// The mirror of the lock assertion, and it is what stops that one passing on a page where the
		// selector is neutralised permanently.
		const live = page.getByRole('combobox', { name: 'Catégorie manuelle' }).first();
		await expect.element(live).toBeInTheDocument();
		expect(live.element().getAttribute('aria-disabled')).toBeNull();
	});
});

describe('an existing répartition opens as the editor (1j-B)', () => {
	it('renders the parts, the count in the section title, and no door', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({ splits: SPLIT_60_20, splitEntryAvailable: false }),
			form: null
		});
		const panel = aside(container);

		const legends = Array.from(panel.querySelectorAll('legend')).map((l) => l.textContent?.trim());
		expect(legends).toContain('Répartition · 2 parts');

		const doors = Array.from(container.querySelectorAll('button')).filter((b) =>
			b.textContent?.includes('Répartir entre plusieurs catégories')
		);
		expect(doors.length).toBe(0);
	});
});

describe('the states after a write (1i)', () => {
	it('failure is an alert INSIDE the panel, above the band, and does not auto-dismiss', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({ splits: SPLIT_60_20, splitEntryAvailable: false }),
			form: actionResult({ splitsError: m.splits_error_generic() })
		});
		const panel = aside(container);

		const alert = panel.querySelector('[role="alert"]') as HTMLElement;
		expect(alert).toBeTruthy();
		expect(alert.textContent).toContain(m.splits_error_generic());

		// Above the band, not at the top of the page: « l'échec appartient à ce formulaire ».
		const band = panel.querySelector('[aria-hidden="true"][data-remainder]') ?? null;
		if (band) {
			expect(alert.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		}
	});

	it('the removal message names the recovered category, which is what makes it obviously lossless', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData(),
			form: actionResult({ splitsRemoved: true })
		});

		expect(container.textContent).toContain(m.splits_success_removed({ category: 'Alimentation' }));
	});

	it('the success message counts the parts', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({ splits: SPLIT_60_20, splitEntryAvailable: false }),
			form: actionResult({ splitsSaved: true, splitsCount: 2 })
		});

		expect(container.textContent).toContain(m.splits_success_saved({ count: 2 }));
	});

	it('a category refusal names the parts; an amount refusal carrying the same positions does not', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({ splits: SPLIT_60_20, splitEntryAvailable: false }),
			form: actionResult({
				splitsCategoryConflict: true,
				splitsError: m.splits_error_category(),
				splitsPositions: [1]
			})
		});
		expect(container.textContent).toContain(m.splits_reason_conflict({ positions: '2' }));

		// The discriminator earning its keep: identical positions, a different refusal, and the panel
		// must NOT tell the user to choose a category when the amount is what was wrong.
		const { container: other } = render(Page, {
			data: baseData({ splits: SPLIT_60_20, splitEntryAvailable: false }),
			form: actionResult({
				splitsError: m.splits_error_invalid_amounts(),
				splitsPositions: [1]
			})
		});
		expect(other.textContent).not.toContain(m.splits_reason_conflict({ positions: '2' }));
	});
});

describe('the mobile sheet mounts the same editor', () => {
	it('at 390, the sheet holds the editor with its controls at the 48px floor', async () => {
		await page.viewport(390, 844);
		render(Page, {
			data: baseData({ splits: SPLIT_60_20, splitEntryAvailable: false }),
			form: null
		});

		const panel = sheet();
		const legends = Array.from(panel.querySelectorAll('legend')).map((l) => l.textContent?.trim());
		expect(legends).toContain('Répartition · 2 parts');

		// « Tous les contrôles passent à 48 px, le plancher de 44 l'emporte sans exception d'écran. »
		// Measured on the real element in the real sheet, not asserted from the `size` prop.
		const named = Array.from(panel.querySelectorAll('input')).find((input) =>
			input.closest('label')?.textContent?.includes('Montant de la part 1')
		) as HTMLInputElement;
		expect(named).toBeTruthy();
		expect(named.getBoundingClientRect().height).toBe(48);

		// And it is genuinely the SHEET's own control rather than the desktop one reached through a
		// shared container. Both mounts are in the document at once — that is this page's documented
		// duplication — and at 390 the desktop `<aside>` is display:none, so it measures 0. Two
		// controls, exactly one of them visible, and the visible one is the 48 the design asks for.
		const heights = Array.from(document.querySelectorAll('input'))
			.filter((input) => input.closest('label')?.textContent?.includes('Montant de la part 1'))
			.map((input) => input.getBoundingClientRect().height)
			.sort((left, right) => left - right);
		expect(heights).toEqual([0, 48]);
	});
});
