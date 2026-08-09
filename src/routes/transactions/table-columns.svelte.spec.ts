import { page } from 'vitest/browser';
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';
import { TRANSACTION_NATURES } from '$lib/domain/transaction';

/**
 * The three protected columns, in one guard.
 *
 * `w-[Npx]` on a `<td>` is only a SUGGESTION: this table is `table-layout: auto`, so a column is
 * sized from its content's intrinsic max-width and any content that cannot shrink wins. The fix,
 * recorded in CLAUDE.md for the Étiquettes column, is a fixed-width inner block carrying the cell's
 * padding — which gives the column a max-content of exactly N.
 *
 * That fix was applied to Étiquettes alone, and the same defect stayed in Catégorie and Montant.
 * Measured in a real browser before this file existed: a long unbreakable category name expanded its
 * column from 160px to 335px and took 175px off Libellé (668 -> 493), and a long multi-word one
 * wrapped and grew the row from 63px to 103px — the exact invariant the Étiquettes column was
 * engineered to protect ("la hauteur de ligne ne bouge pas d'une ligne à l'autre, c'est ce qui garde
 * le tableau scannable").
 *
 * ONE test for all three, deliberately, rather than a third copy of the Étiquettes case: this is one
 * pattern with three sites, and a per-column test is what let two of them survive. Each column was
 * broken separately and watched red — a shared guard that only catches one column would be worse
 * than three separate ones, because it would read as covering all three.
 */

/** Long, and unbreakable: one token with no space is what a column cannot shrink around. */
const UNBREAKABLE = 'Remboursementsprofessionnelsexceptionnels';
/** Long, but breakable: this one does not widen a column, it grows the ROW by wrapping. */
const WORDY = 'Abonnements et services numériques récurrents';

function makeTransaction(overrides: Record<string, unknown> = {}) {
	return {
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
		tags: [],
		...overrides
	};
}

/**
 * Every shape that has ever widened a column or moved a row, on one page:
 * an ordinary row to compare against, both long-category shapes, a long unbreakable LABEL (the 1fr
 * column, which is the one allowed to absorb slack), a long tag name at the chip cap, and an amount
 * far past any real one.
 */
const ROWS = [
	makeTransaction({ id: 'tx-plain' }),
	makeTransaction({ id: 'tx-cat-unbreakable', category: UNBREAKABLE }),
	makeTransaction({ id: 'tx-cat-wordy', category: WORDY }),
	makeTransaction({ id: 'tx-label', label: `${UNBREAKABLE}${UNBREAKABLE}` }),
	makeTransaction({
		id: 'tx-tags',
		tags: [
			{ id: 'tag-1', name: 'Vacances Portugal 2026', colorToken: 'clay' },
			{ id: 'tag-2', name: 'Remboursable Marc', colorToken: 'ochre' }
		]
	}),
	makeTransaction({ id: 'tx-amount', amountCents: -99999999999 }),
	// Two répartie shapes (design 1l–1o). The badge is `shrink-0` beside a `min-w-0 truncate` name,
	// so the case that matters is a LONG UNBREAKABLE dominant category carrying a count: the column
	// holds 160/140 only if the name yields and the number does not. A short category with a badge
	// would pass whatever either of them did.
	makeTransaction({
		id: 'tx-split-many',
		splitIndicator: {
			dominantCategory: UNBREAKABLE,
			dominantNature: 'spending' as const,
			otherCategoryCount: 5,
			partCount: 6,
			parts: [
				{ category: UNBREAKABLE, amountCents: -2000 },
				{ category: 'Maison', amountCents: -1000 },
				{ category: 'Transport', amountCents: -800 },
				{ category: 'Énergie', amountCents: -600 },
				{ category: 'Loisirs', amountCents: -500 },
				{ category: 'Santé', amountCents: -310 }
			]
		}
	}),
	// The « ×2 » form, which renders at a different width — two characters against three — and is
	// the one shape that exists at all only because a bare category name would be indistinguishable
	// from an unsplit row.
	makeTransaction({
		id: 'tx-split-same',
		splitIndicator: {
			dominantCategory: 'Restaurants',
			dominantNature: 'spending' as const,
			otherCategoryCount: 0,
			partCount: 2,
			parts: [
				{ category: 'Restaurants', amountCents: -2605 },
				{ category: 'Restaurants', amountCents: -2605 }
			]
		}
	})
];

function baseData(overrides: Record<string, unknown> = {}): PageData {
	return {
		user: { email: 'test@example.com', role: 'USER' as const },
		transactions: ROWS,
		selectedTransaction: null,
		selectedSuggestion: null,
		categoryOptions: ['Restaurants'],
		splitCategoryOptions: [],
		categories: [{ id: 'cat-restaurants', name: 'Restaurants', defaultKey: null }],
		allTags: [],
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
			totalTransactions: ROWS.length,
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

function selected(overrides: Record<string, unknown> = {}) {
	return baseData({
		selectedTransaction: {
			...ROWS[0],
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
		...overrides
	});
}

/** The rendered width of each column, read off the header row. */
function columnWidths(container: HTMLElement): number[] {
	return [...container.querySelectorAll('table thead th')].map((th) =>
		Math.round(th.getBoundingClientRect().width)
	);
}

function rowHeights(container: HTMLElement): number[] {
	return [...container.querySelectorAll('table tbody tr')].map((tr) =>
		Math.round(tr.getBoundingClientRect().height)
	);
}

describe('the table holds its column set whatever the content', () => {
	it('pins Catégorie, Étiquettes and Montant in both column sets, and keeps every row one height', async () => {
		expect.assertions(5);
		await page.viewport(1280, 800);

		// MEASURED, not read off class lists. A class assertion passes happily against a column that
		// is nothing like the figure it names — which is precisely how this defect survived: the
		// header measured 190px while the rendered column was 262px.
		const roomy = render(Page, { data: baseData(), form: null });
		const roomyCols = columnWidths(roomy.container);
		// Libellé is `1fr` and is the ONLY column allowed to move: it absorbs the slack.
		expect(roomyCols.slice(1)).toEqual([160, 240, 130]);
		// One height for every row, including the two long-category rows and the two répartie ones.
		// A wrapped category grows its row, and a table whose row height follows its content stops
		// being scannable. The badge is free only as long as it stays under the height the Libellé
		// cell's two lines already fix — which is a claim about MARGINS, not about the badge's own
		// 24px, and it is the claim the tags chantier got wrong.
		expect(new Set(rowHeights(roomy.container)).size).toBe(1);
		roomy.unmount();

		const tight = render(Page, { data: selected(), form: null });
		const tightCols = columnWidths(tight.container);
		expect(tightCols.slice(1)).toEqual([140, 190, 110]);
		expect(new Set(rowHeights(tight.container)).size).toBe(1);
		// And the narrowing is the ONLY thing that moved the 1fr column: it gave up width to the
		// panel rather than to a neighbour that refused to shrink.
		expect(tightCols[0]).toBeLessThan(roomyCols[0]);
	});
});
