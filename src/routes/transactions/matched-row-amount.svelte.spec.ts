import { page } from 'vitest/browser';
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
// Load-bearing, and not optional: this file measures nothing, but the page it renders reads its
// breakpoint classes from here, and without the stylesheet the desktop table and the mobile list
// are both "visible" at once, so every scoped query below would match twice. See CLAUDE.md.
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';
import { TRANSACTION_NATURES, type TransactionNature } from '$lib/domain/transaction';
import * as m from '$lib/paraglide/messages';

/**
 * WHEN THE SECONDARY « sur {total} » LINE RENDERS, AND WHEN IT MUST NOT.
 *
 * The rule: it appears only when the matched allocation is a genuine FRAGMENT of the row's total.
 * The trap is that "is it a fragment" was decided by comparing two SIGNED numbers whose signs come
 * from different places — the matched amount is signed by the row's resolved kind, the row's own
 * amount by whatever the loader put in the column. The two write paths disagree there: manual entry
 * stores a signed value, `import/persist.ts` stores `Math.abs(...)` and puts the direction in
 * `type`. So an unsplit IMPORTED expense compared -4290 against +4290 and reported itself a
 * fragment of itself.
 *
 * `IMPORTED_MAGNITUDE` below is that row, and it is the fixture this suite did not have: every
 * other transaction fixture in this repo is built the signed way, which is precisely why nothing
 * went red. CLAUDE.md's own line — a fixture that holds still is not a neutral fixture, it is one
 * that has removed the conditions under which the bug happens.
 */

const SPENDING: TransactionNature = 'spending';

function makeTransaction(overrides: Record<string, unknown> = {}) {
	return {
		id: 'tx-1',
		date: '2026-06-12',
		label: 'Carrefour Market',
		category: 'Transport',
		importedCategory: 'Transport',
		manualCategory: null,
		isManualCategory: false,
		nature: SPENDING,
		natureSource: 'default' as const,
		manualNature: null,
		amountCents: -4290,
		type: 'expense' as const,
		source: 'csv',
		tags: [],
		splitIndicator: null,
		matchedCategoryAllocation: null,
		suggestion: null,
		...overrides
	};
}

/**
 * An UNSPLIT row written the way the CSV importer writes one: a positive magnitude in the column,
 * the direction in `type`. Its single allocation IS its total, so no secondary line may appear.
 */
const IMPORTED_MAGNITUDE = makeTransaction({
	id: 'tx-imported',
	label: 'IMPORTE NON REPARTI',
	amountCents: 4_290,
	matchedCategoryAllocation: { category: 'Transport', nature: SPENDING, amountCents: -4_290 }
});

/** A genuinely partial row: 20,00 € of an 80,00 € parent matched the filter. */
const GENUINE_FRAGMENT = makeTransaction({
	id: 'tx-fragment',
	label: 'EDF FACTURE',
	amountCents: -8_000,
	matchedCategoryAllocation: { category: 'Transport', nature: SPENDING, amountCents: -2_000 }
});

function baseData(overrides: Record<string, unknown> = {}): PageData {
	return {
		user: { email: 'test@example.com', role: 'USER' as const },
		transactions: [makeTransaction()],
		selectedTransaction: null,
		allTags: [],
		selectedSuggestion: null,
		categoryOptions: ['Transport'],
		splitCategoryOptions: [],
		categories: [{ id: 'cat-transport', name: 'Transport', defaultKey: null }],
		natureOptions: TRANSACTION_NATURES,
		splitFilterAvailable: false,
		splitCounts: null,
		filters: {
			q: '',
			qMode: 'contains' as const,
			type: 'all',
			// The whole subject: the secondary line exists only under a category filter.
			category: 'Transport',
			from: '',
			to: '',
			importBatchId: '',
			ids: '',
			tag: '',
			split: 'all'
		},
		filteredTotals: { incomeCents: 0, expenseCents: 4_290 },
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

/** The sentence the secondary line renders, for whichever total is passed. */
const secondaryFor = (amountCents: number) =>
	m.transactions_row_matched_of({
		amount: new Intl.NumberFormat('fr', { style: 'currency', currency: 'EUR' }).format(
			amountCents / 100
		)
	});

/**
 * A row the filter matched by PARENT IDENTITY, with none of its money in the filtered category:
 * filed under « Revenus », split entirely into Salaire and Épargne, so the remainder is zero and
 * `allocateByCategory` drops it. `buildTransactionWhere` widens the filter to such rows on purpose
 * (OD-1), so it IS on screen, and the only truthful amount for it is zero.
 */
const IDENTITY_ONLY = makeTransaction({
	id: 'tx-identity',
	label: 'VIREMENT EMPLOYEUR',
	category: 'Revenus',
	importedCategory: 'Revenus',
	amountCents: 250_000,
	type: 'income' as const,
	splitIndicator: {
		dominantCategory: 'Salaire',
		dominantNature: SPENDING,
		otherCategoryCount: 1,
		partCount: 2,
		parts: [
			{ category: 'Salaire', amountCents: 200_000 },
			{ category: 'Épargne', amountCents: 50_000 }
		]
	},
	matchedCategoryAllocation: { category: 'Revenus', nature: SPENDING, amountCents: 0 }
});

describe('a row matched by parent identity, carrying none of the filtered money', () => {
	it('shows zero and the category that matched, never the dominant part and the full total', async () => {
		expect.assertions(3);
		await page.viewport(1280, 800);
		render(Page, { data: baseData({ transactions: [IDENTITY_ONLY] }), form: null });

		const table = page.getByRole('table');
		// The figure the band also reports for this row, so the two agree by construction.
		await expect.element(table.getByText('0,00\u00a0\u20ac', { exact: true })).toBeInTheDocument();
		// The category the filter matched…
		await expect.element(table.getByText('Revenus', { exact: true })).toBeInTheDocument();
		// …and NOT the dominant part, which is the pre-fix display and is false about this filter:
		// no money in this transaction is Revenus, and « Salaire » is not what was asked for.
		expect(table.getByText('Salaire', { exact: true }).elements()).toEqual([]);
	});
});

describe('the secondary « sur {total} » line under a category filter', () => {
	it('renders on a genuine fragment — so the absence asserted below is an absence of something possible', async () => {
		expect.assertions(1);
		await page.viewport(1280, 800);
		render(Page, { data: baseData({ transactions: [GENUINE_FRAGMENT] }), form: null });

		// APPEAR FIRST. A negative assertion whose subject has never been shown to appear proves
		// nothing at all — it passes on an empty table, on an unmounted component, on a typo in the
		// message key.
		await expect
			.element(page.getByRole('table').getByText(secondaryFor(-8_000)))
			.toBeInTheDocument();
	});

	it('does NOT render on an unsplit row stored as a positive magnitude', async () => {
		expect.assertions(2);
		await page.viewport(1280, 800);
		render(Page, { data: baseData({ transactions: [IMPORTED_MAGNITUDE] }), form: null });

		const table = page.getByRole('table');
		// The row is on screen, so the absence below is about the LINE and not about the row.
		await expect.element(table.getByText('IMPORTE NON REPARTI')).toBeInTheDocument();
		// Either sign of the same figure: the defect rendered « sur 42,90 € » beside a primary
		// « -42,90 € », so asserting only the signed spelling would have missed it.
		const spurious = [secondaryFor(4_290), secondaryFor(-4_290)].flatMap((sentence) =>
			table.getByText(sentence).elements()
		);
		expect(spurious).toEqual([]);
	});
});
