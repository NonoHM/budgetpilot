import { describe, expect, it } from 'vitest';
import * as m from '$lib/paraglide/messages';
import type { Transaction } from '$lib/domain/transaction';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { allocationsOf, type CategoryAllocation } from '$lib/domain/allocation';
import { getEffectiveTransactionNature } from '$lib/server/transactions/nature';
import {
	anonymizeLabel,
	anonymizeMerchant,
	buildMonthlyReport,
	buildPeriodReport,
	getRecurringPayments
} from './monthly';

/**
 * Derives the MONEY view from the fixture's IDENTITY view, by calling the canonical helpers rather
 * than restating the remainder rule or the nature default (see CLAUDE.md: an oracle that retypes
 * the rule it audits drifts by exactly the clause it forgets). Every fixture in this file is
 * unsplit, so this always yields exactly one allocation per transaction, carrying its whole amount.
 */
function toAllocations(transactions: Transaction[]): CategoryAllocation[] {
	return transactions.flatMap((transaction) =>
		allocationsOf({
			...transaction,
			nature: transaction.nature ?? getEffectiveTransactionNature(transaction, new Map()).nature
		})
	);
}

const transactions: Transaction[] = [
	{
		id: 'income-manual',
		date: '2026-06-01',
		label: 'Salaire',
		amountCents: 200_000,
		type: 'income',
		category: 'Revenus',
		source: 'manual'
	},
	{
		id: 'income-legacy',
		date: '2026-06-02',
		label: 'Remboursement',
		amountCents: 15_000,
		type: 'income',
		category: 'Remboursements',
		source: 'csv'
	},
	{
		id: 'rent',
		date: '2026-06-03',
		label: 'VIREMENT LOYER REFAB123456789 FR7612341234123412341234123',
		amountCents: -80_000,
		type: 'expense',
		category: 'Logement',
		source: 'banque_populaire'
	},
	{
		id: 'subscription-1',
		date: '2026-06-04',
		label: 'ABONNEMENT MUSIQUE 123456',
		amountCents: -999,
		type: 'expense',
		category: 'Loisirs',
		source: 'banque_populaire'
	},
	{
		id: 'subscription-2',
		date: '2026-06-18',
		label: 'ABONNEMENT MUSIQUE 654321',
		amountCents: -1_049,
		type: 'expense',
		category: 'Loisirs',
		source: 'mock_connector'
	},
	{
		id: 'other-month',
		date: '2026-05-20',
		label: 'Ancien achat',
		amountCents: -5_000,
		type: 'expense',
		category: 'Autre',
		source: 'csv'
	}
];

describe('buildMonthlyReport', () => {
	it('compte toutes les incomes et expenses du mois sans filtre source', () => {
		expect.assertions(7);

		const report = buildMonthlyReport(transactions, toAllocations(transactions), '2026-06');

		expect(report.incomeCents).toBe(215_000);
		expect(report.expenseCents).toBe(82_048);
		expect(report.balanceCents).toBe(132_952);
		expect(report.transactionCount).toBe(5);
		expect(report.expenseAveragePerDayCents).toBe(2_735);
		expect(report.savingsRate).toBeCloseTo(0.618, 3);
		expect(report.takeaways.length).toBeGreaterThanOrEqual(3);
	});

	it('produit des takeaways structurés (code + champs optionnels), pas des chaînes libres', () => {
		expect.assertions(2);

		const report = buildMonthlyReport(transactions, toAllocations(transactions), '2026-06');
		const topCategoryTakeaway = report.takeaways.find(
			(takeaway) => takeaway.code === 'top_category'
		);

		expect(
			report.takeaways.every(
				(takeaway) => typeof takeaway === 'object' && typeof takeaway.code === 'string'
			)
		).toBe(true);
		expect(topCategoryTakeaway).toMatchObject({
			code: 'top_category',
			category: 'Logement',
			percent: expect.stringMatching(/^\d+ %$/)
		});
	});

	it('compare le mois courant au mois précédent', () => {
		expect.assertions(3);

		const report = buildMonthlyReport(transactions, toAllocations(transactions), '2026-06', {
			month: '2026-05',
			incomeCents: 100_000,
			expenseCents: 40_000,
			balanceCents: 60_000
		});

		expect(report.previousMonth?.incomeDeltaCents).toBe(115_000);
		expect(report.previousMonth?.expenseDeltaCents).toBe(42_048);
		expect(report.previousMonth?.balanceDeltaCents).toBe(72_952);
	});
});

/** Every property name in a nested structure, so a key check cannot miss a nested one. */
function collectKeys(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(collectKeys);
	if (value && typeof value === 'object') {
		return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
	}
	return [];
}

describe('buildPeriodReport', () => {
	it('carries no tag data, so tag names can never reach the AI prompt payload', () => {
		expect.assertions(3);

		// buildPeriodReport feeds server/insights/summary.ts, which builds the Ollama prompt. A tag
		// name is free text a user wrote about their own life: "Vacances Portugal 2026" is a life
		// event, where a category name is a taxonomy term. This asserts the ABSENCE structurally,
		// so a future chantier that adds tags to /reports goes red here rather than silently
		// widening what leaves the machine.
		//
		// The tag is attached to the INPUT deliberately. The point is not that the domain type has
		// no `tags` field today, it is that the report drops the data even when handed it, so the
		// guard survives a future widening of that type. The cast is what lets the test hand it
		// over; without it this would only be asserting the current shape of the type.
		const tagged = [
			{
				id: 'tagged-expense',
				date: '2026-06-05',
				label: 'Hotel Lisbonne',
				amountCents: -42_000,
				type: 'expense',
				category: 'Voyage',
				source: 'csv',
				tags: ['Portugal']
			}
		] as unknown as Transaction[];

		const report = buildPeriodReport(tagged, toAllocations(tagged), '2026-06');

		// Two complementary checks, because either alone is a bad guard.
		//
		// The VALUE check is over the whole serialized payload, so a tag name reaching it nested
		// inside any existing structure is caught, not only under a top-level `tags` key.
		expect(JSON.stringify(report)).not.toContain('Portugal');

		// The KEY check has to compare whole words, not substrings. A naive
		// `not.toContain('tag')` over the lowercased payload was written first and failed
		// immediately on `percentageOfExpenses`, which contains "percen-TAG-e". That version would
		// have had to be deleted or loosened, and a loosened one guards nothing.
		const tagLikeKeys = collectKeys(report).filter((key) =>
			key
				.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
				.toLowerCase()
				.split(' ')
				.some((word) => word === 'tag' || word === 'tags')
		);
		expect(tagLikeKeys).toEqual([]);

		// Guards the guard: if the report came back empty the two checks above would pass for the
		// wrong reason. This proves the transaction was actually processed.
		expect(report.expenseCents).toBe(42_000);
	});

	it('compte une income du mois précédent dans une période glissante', () => {
		expect.assertions(6);

		const slidingTransactions: Transaction[] = [
			{
				id: 'income-last-month',
				date: '2026-05-28',
				label: 'Salaire',
				amountCents: 177_000,
				type: 'income',
				category: 'Revenus',
				source: 'csv'
			},
			{
				id: 'expense-current-month',
				date: '2026-06-20',
				label: 'Courses',
				amountCents: -7_000,
				type: 'expense',
				category: 'Alimentation',
				source: 'banque_populaire'
			}
		];
		const report = buildPeriodReport(
			slidingTransactions,
			toAllocations(slidingTransactions),
			'30 derniers jours',
			undefined,
			{ dayCount: 30 }
		);

		expect(report.incomeCents).toBe(177_000);
		expect(report.expenseCents).toBe(7_000);
		expect(report.balanceCents).toBe(170_000);
		expect(report.expenseAveragePerDayCents).toBe(233);
		expect(report.savingsRate).toBeCloseTo(0.96, 2);
		expect(report.natureAnalysis.spendingCents).toBe(7_000);
	});

	it('sépare les natures analytiques', () => {
		expect.assertions(4);

		const natureTransactions: Transaction[] = [
			{
				id: 'fee',
				date: '2026-06-10',
				label: 'Commission',
				amountCents: -500,
				type: 'expense',
				category: 'Frais bancaires',
				source: 'csv',
				nature: 'fee'
			},
			{
				id: 'refund',
				date: '2026-06-11',
				label: 'Remboursement',
				amountCents: 2_000,
				type: 'income',
				category: 'Remboursements',
				source: 'csv',
				nature: 'refund'
			},
			{
				id: 'investment',
				date: '2026-06-12',
				label: 'PEA',
				amountCents: -15_000,
				type: 'expense',
				category: 'Investissement',
				source: 'csv',
				nature: 'investment'
			}
		];
		const report = buildPeriodReport(natureTransactions, toAllocations(natureTransactions), 'juin');

		expect(report.natureAnalysis.feeCents).toBe(500);
		expect(report.natureAnalysis.refundCents).toBe(2_000);
		expect(report.natureAnalysis.investmentCents).toBe(15_000);
		expect(report.natureAnalysis.spendingCents).toBe(0);
	});
});

describe('getRecurringPayments', () => {
	it('détecte les libellés normalisés avec des montants similaires', () => {
		expect.assertions(9);

		const recurringPayments = getRecurringPayments(
			transactions.filter((transaction) => transaction.type === 'expense')
		);

		expect(recurringPayments).toHaveLength(1);
		expect(recurringPayments[0].label).toBe('Musique - Loisirs');
		expect(recurringPayments[0].label).not.toContain('ABONNEMENT');
		expect(recurringPayments[0].label).not.toContain('123456');
		expect(recurringPayments[0].amountCents).toBe(1_024);
		expect(recurringPayments[0].totalAmountCents).toBe(2_048);
		expect(recurringPayments[0].count).toBe(2);
		expect(recurringPayments[0].lastDate).toBe('2026-06-18');
		expect(recurringPayments[0].confidence).toBe('moyenne');
	});

	it('anonymise les plus grosses dépenses sans exposer de référence bancaire', () => {
		expect.assertions(8);

		const cardTransactions: Transaction[] = [
			{
				id: 'card',
				date: '2026-06-10',
				label: 'CARTE 4970123412341234 AUCHAN 23/06;Debit;42,10;Reference BP123456789',
				amountCents: -4_210,
				type: 'expense',
				category: 'Alimentation',
				source: 'csv'
			},
			...transactions.filter((transaction) => transaction.date.startsWith('2026-06-'))
		];
		const report = buildPeriodReport(cardTransactions, toAllocations(cardTransactions), 'juin');
		const cardExpense = report.largestExpenses.find((expense) => expense.label.includes('Auchan'));

		expect(report.largestExpenses[0].label).toBe('Loyer - Logement');
		expect(cardExpense?.label).toBe('Auchan - Alimentation');
		expect(cardExpense?.label).not.toContain('4970123412341234');
		expect(cardExpense?.label).not.toContain('BP123456789');
		expect(cardExpense?.label).not.toContain('Reference');
		expect(cardExpense?.label).not.toContain('Debit');
		expect(report.largestExpenses[1].label).not.toContain('ABONNEMENT');
		expect(report.topCategories[0].percentageOfExpenses).toBeCloseTo(0.927, 3);
	});

	/**
	 * OD-3 says the RANKING and the displayed category/amount stay the parent's, whole. This is the
	 * negative half of that claim: a split does not move the row or relabel it. The positive half —
	 * that the row also carries the breakdown — is `splitIndicator` below.
	 */
	it("garde le classement et le montant du PARENT sur une dépense répartie (OD-3), et y ajoute l'indicateur de répartition", () => {
		expect.assertions(4);

		const rent: Transaction = {
			id: 'rent-split',
			date: '2026-06-05',
			label: 'Loyer juin',
			amountCents: -120_000,
			type: 'expense',
			category: 'Logement',
			source: 'manual'
		};
		const allocations = allocationsOf(
			{ ...rent, nature: getEffectiveTransactionNature(rent, new Map()).nature },
			[{ category: 'Assurance', amountCents: -20_000 }]
		);

		const report = buildPeriodReport([rent], allocations, 'juin');
		const [expense] = report.largestExpenses;

		// Parent-shaped, unmoved by the split: 120 000, not 100 000 (the remainder) or 20 000.
		expect(expense.amountCents).toBe(120_000);
		expect(expense.category).toBe('Logement');
		expect(expense.splitIndicator?.dominantCategory).toBe('Logement');
		expect(expense.splitIndicator?.parts).toEqual([
			{ category: 'Assurance', amountCents: -20_000 },
			{ category: 'Logement', amountCents: -100_000 }
		]);
	});
});

describe('anonymizeMerchant / anonymizeLabel', () => {
	/**
	 * Recorded from the implementation BEFORE `anonymizeMerchant` was split out of
	 * `anonymizeLabel`. The split has to be a pure refactor — every existing caller (the reports,
	 * the cash-flow forecast view) keeps byte-identical output — so these literals are the
	 * regression guard, not a restatement of the current code.
	 */
	const RECORDED: [string, string, string][] = [
		['CB ABONNEMENT NETFLIX 0712', 'Abonnements', 'Netflix - Abonnements'],
		['PRELEVEMENT SEPA LOYER SCI DUPONT REF9912345', 'Logement', 'Loyer Sci Dupont - Logement'],
		['VIREMENT SALAIRE ACME SAS', 'Revenus', 'Salaire Acme Sas - Revenus'],
		// Nothing survives sanitization -> the neutral fallback, still composed with the category.
		['FR7630006000011234567890189', 'Divers', 'Dépense - Divers'],
		['123456789', 'Divers', 'Dépense - Divers'],
		['CB 12/03 CARTE', 'Divers', 'Dépense - Divers'],
		['Café Crème & Co', 'Restaurants', 'Cafe Creme Co - Restaurants']
	];

	it('anonymizeLabel produit exactement la même sortie qu’avant l’extraction', () => {
		for (const [label, category, expected] of RECORDED) {
			expect(anonymizeLabel(label, category)).toBe(expected);
		}
	});

	it('anonymizeLabel reste la composition de anonymizeMerchant et de la catégorie', () => {
		for (const [label, category] of RECORDED) {
			expect(anonymizeLabel(label, category)).toBe(`${anonymizeMerchant(label)} - ${category}`);
		}
	});

	it('anonymizeMerchant ne contient jamais la catégorie ni le séparateur', () => {
		for (const [label, category] of RECORDED) {
			const merchant = anonymizeMerchant(label);
			expect(merchant).not.toContain(' - ');
			expect(merchant).not.toContain(category);
		}
	});

	it('anonymizeMerchant retombe sur le libellé neutre quand rien ne survit', () => {
		expect(anonymizeMerchant('FR7630006000011234567890189')).toBe('Dépense');
	});

	/**
	 * Separates "the composed label carries the stored sentinel slug" from "it carries the
	 * sentinel's display name". Both states produce a label of the same SHAPE, which is why the
	 * assertion names the two strings rather than the shape: this defect shipped in 0.14.0 with
	 * every structural test above it green.
	 *
	 * `UNCLASSIFIED_CATEGORY` is a technical slug, never a name (see domain/categories.ts). It
	 * reaches four render paths through this one function — `largestExpenses[].label`,
	 * `recurringPayments[].label`, the forecast's `flows[].label` and its ledger `events[].label` —
	 * so /reports printed "Zorglub - uncategorized" in a table whose next column already read
	 * "Non catégorisé", and the dashboard's forecast chart printed it in its tooltip.
	 */
	it('composes the sentinel category as its display name, never as the stored slug', () => {
		const composed = anonymizeLabel('CB ABONNEMENT ZORGLUB', UNCLASSIFIED_CATEGORY);

		expect(composed).toBe(`Zorglub - ${m.common_category_uncategorized()}`);
		expect(composed).not.toContain(UNCLASSIFIED_CATEGORY);
	});

	/**
	 * The other half, and it is what keeps the fix from being a rename: an ordinary category is a
	 * NAME and is shown as stored (#162). Separates "the sentinel is translated" from "every
	 * category is translated", which the RECORDED literals above would not catch on their own if
	 * the display function ever grew a second branch.
	 */
	it('leaves an ordinary category name exactly as stored', () => {
		expect(anonymizeLabel('CB ABONNEMENT ZORGLUB', 'Abonnements')).toBe('Zorglub - Abonnements');
	});
});

/**
 * Sibling of the /reports forecast-flows collision (`toDisplayCashFlowForecast — flow identity`):
 * `report.recurringPayments` is rendered by a keyed `#each` too, and nothing in a
 * `RecurringPayment` identifies it. Two DIFFERENT groups can produce an identical
 * (label, category, amountCents) triple, because grouping and display use two different
 * normalizers: `normalizeRecurringLabel` decides which transactions form a group and keeps the
 * whole label, while `anonymizeMerchant` truncates the displayed one at 28 characters. Two
 * branches of one chain, priced the same, therefore group apart and display identically — and a
 * duplicate `#each` key is a Svelte 5 runtime throw that blanks the route.
 */
describe('getRecurringPayments — stream identity', () => {
	function branchSubscription(branch: string, index: number): Transaction {
		return {
			id: `sub-${branch}-${index}`,
			date: `2026-06-${String(2 + index * 14).padStart(2, '0')}`,
			label: `ABONNEMENT SALLE DE SPORT BASIC FIT PARIS ${branch}`,
			amountCents: -2_990,
			type: 'expense',
			category: 'Loisirs',
			source: 'csv'
		};
	}

	it('gives each detected stream a distinct id, even when two display identically', () => {
		expect.assertions(3);

		const payments = getRecurringPayments([
			branchSubscription('NATION', 0),
			branchSubscription('NATION', 1),
			branchSubscription('BERCY', 0),
			branchSubscription('BERCY', 1)
		]);

		// The premise: two separate streams that the rendered key cannot tell apart. Without these
		// two assertions the uniqueness check below would hold vacuously.
		expect(payments).toHaveLength(2);
		expect(new Set(payments.map((p) => `${p.label}:${p.category}:${p.amountCents}`)).size).toBe(1);

		expect(new Set(payments.map((p) => p.id)).size).toBe(2);
	});
});
