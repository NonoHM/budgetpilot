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
 * Wiring for transactions/+page.svelte:5.1 step 5 (TagChips on the desktop table row and the
 * mobile ListCard) and the TransactionTagsEditor mount in the detail panel / bottom sheet. The
 * cap-at-2-plus-N behaviour itself is exhaustively covered at the component level
 * (ui/TagChips.svelte.spec.ts); what only a browser render of the real page can prove is that a
 * transaction's tags actually reach TagChips through the row markup, on both surfaces — the exact
 * shape of defect #97 found (a control wired on one surface and silently missing on the other).
 */

const THREE_TAGS = [
	{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' },
	{ id: 'tag-2', name: 'Pro', colorToken: 'ochre' },
	{ id: 'tag-3', name: 'Remboursement Paul', colorToken: 'olive' }
];

function makeTransaction(overrides: Record<string, unknown> = {}) {
	return {
		id: 'tx-1',
		date: '2026-06-12',
		label: 'Carrefour Market',
		category: 'Alimentation',
		importedCategory: 'Alimentation',
		manualCategory: null,
		isManualCategory: false,
		nature: SPENDING,
		natureSource: 'default' as const,
		manualNature: null,
		amountCents: -5420,
		type: 'expense' as const,
		source: 'Carrefour Market SA',
		tags: THREE_TAGS,
		suggestion: null,
		...overrides
	};
}

function baseData(overrides: Record<string, unknown> = {}): PageData {
	return {
		user: { email: 'test@example.com', role: 'USER' as const },
		transactions: [makeTransaction()],
		selectedTransaction: {
			id: 'tx-1',
			date: '2026-06-12',
			label: 'Carrefour Market',
			amountCents: -5420,
			type: 'expense' as const,
			category: 'Alimentation',
			importedCategory: 'Alimentation',
			manualCategory: null,
			isManualCategory: false,
			nature: SPENDING,
			natureSource: 'default' as const,
			manualNature: null,
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
			tags: [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' }]
		},
		allTags: THREE_TAGS,
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
			ids: '',
			tag: ''
		},
		filteredTotals: { incomeCents: 0, expenseCents: 5420 },
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
		...overrides
	};
}

describe('tag chips on the transactions list rows', () => {
	// Both the desktop table and the mobile ListCard render simultaneously regardless of viewport
	// (same shape CLAUDE.md records for /upcoming-bills and /reports), so every assertion here is
	// scoped to ONE surface's row rather than to the page as a whole: an unscoped getByText would
	// also match the OTHER surface's row, and — once a transaction is selected — the detail
	// panel's own TagPicker chip for the same tag name.

	it('desktop: shows the first two tags and collapses the third as +1', async () => {
		await page.viewport(1280, 800);
		render(Page, { data: baseData(), form: null });

		const table = page.getByRole('table');
		await expect.element(table.getByText('Portugal')).toBeInTheDocument();
		await expect.element(table.getByText('Pro')).toBeInTheDocument();
		expect(table.getByText('Remboursement Paul').elements().length).toBe(0);
		await expect
			.element(table.getByRole('button', { name: /1 étiquette de plus/ }))
			.toBeInTheDocument();
	});

	it('mobile: shows the first two tags and collapses the third as +1', async () => {
		await page.viewport(390, 844);
		const { container } = render(Page, {
			data: baseData({ selectedTransaction: null }),
			form: null
		});

		const row = container.querySelector('#tx-row-tx-1') as HTMLElement;
		expect(row.textContent).toContain('Portugal');
		expect(row.textContent).toContain('Pro');
		expect(row.textContent).not.toContain('Remboursement Paul');
	});

	it('keeps the row height identical whatever the tag count, in a column that stays 190px', async () => {
		// The design grants the row-chips exception to "a table shows only what you scan at a glance"
		// against exactly two counterparts, and this is both of them: a dedicated 190px column, and
		// a row height that does not move ("jamais de retour à la ligne", "la hauteur de ligne ne
		// bouge pas d'une ligne à l'autre, c'est ce qui garde le tableau scannable").
		//
		// Measured on the rendered table, not read off classes, because both halves failed silently
		// while the markup looked right: `w-[190px]` sat on the <th> only, `table-layout` is auto,
		// and content that could not shrink widened the column to 262px while the chips wrapped and
		// rows grew to 76px and 80px.
		//
		// BREAK-THE-CHECK: restoring `flex-wrap` on TagChips' <ul> (or dropping `min-w-0` from its
		// <li>) reproduces the original numbers here — verified by hand, see the PR report.
		// Names long enough to hit the 110px per-chip cap, deliberately. With short names two chips
		// fit on one line even while wrapping is enabled, so this test passed against the defect
		// when it was first written with THREE_TAGS ("Portugal", "Pro"). The real rows that exposed
		// it carried "Vacances Portugal 2026" and "Remboursable Marc" — at the cap, which is the
		// only width where wrap and nowrap differ.
		const LONG_TAGS = [
			{ id: 'tag-1', name: 'Vacances Portugal 2026', colorToken: 'clay' },
			{ id: 'tag-2', name: 'Remboursable Marc', colorToken: 'ochre' },
			{ id: 'tag-3', name: 'Travaux salle de bain', colorToken: 'olive' }
		];

		await page.viewport(1280, 800);
		const { container } = render(Page, {
			data: baseData({
				transactions: [
					makeTransaction({ id: 'tx-none', label: 'Sans étiquette', tags: [] }),
					makeTransaction({ id: 'tx-one', label: 'Une étiquette', tags: [LONG_TAGS[0]] }),
					makeTransaction({ id: 'tx-two', label: 'Deux étiquettes', tags: LONG_TAGS.slice(0, 2) }),
					makeTransaction({ id: 'tx-three', label: 'Trois étiquettes', tags: LONG_TAGS })
				]
				// The selection from `baseData` is KEPT here, deliberately: there are now two column
				// sets (240px unselected, 190px selected), and 190 is the one this test is about.
				// It is the narrower of the two and therefore the only one where wrap and nowrap can
				// differ at the 110px chip cap — measuring the roomy set would let the defect this
				// test was written for back in. Its id matches no row in this fixture, so no row is
				// marked current and the heights being compared stay strictly comparable.
			}),
			form: null
		});

		const rows = [...container.querySelectorAll('table tbody tr')] as HTMLElement[];
		expect(rows).toHaveLength(4);

		const heights = rows.map((row) => Math.round(row.getBoundingClientRect().height));
		expect(new Set(heights).size).toBe(1);

		for (const row of rows) {
			const cell = row.querySelectorAll('td')[2] as HTMLElement;
			expect(Math.round(cell.getBoundingClientRect().width)).toBe(190);

			// One line, and inside the cell: nowrap on its own turns wrapping into overflow, so the
			// column width assertion above would still pass while chips spilled over the amount.
			const list = cell.querySelector('ul');
			if (!list) continue;
			// Centres, not tops: `items-center` aligns an 18px chip and the 24px "+N" button on the
			// same line with deliberately different tops, so a top-equality check fails on a correct
			// rendering.
			const items = [...list.querySelectorAll(':scope > li')] as HTMLElement[];
			const centres = new Set(
				items.map((li) => {
					const rect = li.getBoundingClientRect();
					return Math.round(rect.top + rect.height / 2);
				})
			);
			expect(centres.size).toBe(1);
			expect(list.getBoundingClientRect().right).toBeLessThanOrEqual(
				cell.getBoundingClientRect().right + 1
			);
		}
	});

	it('renders no chip at all for a transaction with no tags', async () => {
		await page.viewport(1280, 800);
		render(Page, {
			data: baseData({
				transactions: [makeTransaction({ tags: [] })],
				selectedTransaction: null
			}),
			form: null
		});

		expect(page.getByRole('table').getByText('Portugal').elements().length).toBe(0);
	});
});

describe('TransactionTagsEditor mounted on the detail surfaces', () => {
	it('desktop: the panel offers the tags section with the current tag as a removable chip', async () => {
		await page.viewport(1280, 800);
		const { container } = render(Page, { data: baseData(), form: null });

		const aside = container.querySelector('aside') as HTMLElement;
		expect(aside.textContent).toContain('Étiquettes');
		await expect
			.element(page.getByRole('button', { name: m.tags_remove_aria({ name: 'Portugal' }) }))
			.toBeInTheDocument();
	});

	it('mobile: the bottom sheet offers the tags section with the current tag as a removable chip', async () => {
		await page.viewport(390, 844);
		render(Page, { data: baseData(), form: null });

		const sheet = page.getByRole('dialog');
		// A group, not a heading: the editor is a <fieldset> whose <legend> names it, which is what
		// ties the controls to that name for a screen reader. A heading sitting beside them does not.
		await expect.element(sheet.getByRole('group', { name: 'Étiquettes' })).toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: m.tags_remove_aria({ name: 'Portugal' }) }))
			.toBeInTheDocument();
	});
});
