import { describe, expect, it, vi } from 'vitest';
import { summarizeMonthlyBudget } from '$lib/domain/budget';
import type { Transaction } from '$lib/domain/transaction';
import { getBudgetInsights } from './index';
import { buildBudgetInsightsPrompt } from './prompt';
import { generateRuleInsights } from './rules';
import { buildTransactionSummary } from './summary';

const transactions: Transaction[] = [
	{
		id: 'income',
		date: '2026-06-01',
		label: 'Salaire',
		amountCents: 100_000,
		type: 'income',
		category: 'Revenus',
		source: 'manual'
	},
	{
		id: 'expense-1',
		date: '2026-06-02',
		label: 'CARTE 4970123412341234 AUCHAN 23/06;Debit;42,10;Reference BP123456789',
		amountCents: -110_000,
		type: 'expense',
		category: 'Logement',
		source: 'banque_populaire'
	},
	{
		id: 'expense-2',
		date: '2026-06-12',
		label: 'ABONNEMENT MUSIQUE 123456',
		amountCents: -999,
		type: 'expense',
		category: 'Loisirs',
		source: 'banque_populaire'
	},
	{
		id: 'expense-3',
		date: '2026-06-20',
		label: 'ABONNEMENT MUSIQUE 654321',
		amountCents: -999,
		type: 'expense',
		category: 'Loisirs',
		source: 'banque_populaire'
	}
];

describe('Budget Insights', () => {
	it('fonctionne sans LLM avec les règles déterministes', async () => {
		expect.assertions(3);

		const monthlySummary = summarizeMonthlyBudget(transactions, [], '2026-06');
		const result = await getBudgetInsights({
			transactions,
			monthlySummary,
			env: { LLM_ENABLED: 'false' }
		});

		expect(result.localAiUnavailable).toBe(false);
		expect(result.insights.some((item) => item.id === 'negative-balance')).toBe(true);
		expect(result.insights.every((item) => item.source === 'rules')).toBe(true);
	});

	it('garde le fallback si Ollama est indisponible', async () => {
		expect.assertions(3);

		const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
		const monthlySummary = summarizeMonthlyBudget(transactions, [], '2026-06');
		const result = await getBudgetInsights({
			transactions,
			monthlySummary,
			env: {
				LLM_ENABLED: 'true',
				LLM_PROVIDER: 'ollama',
				LLM_BASE_URL: 'http://127.0.0.1:11434',
				LLM_MODEL: 'qwen2.5:0.5b',
				LLM_TIMEOUT_MS: '10'
			}
		});

		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:11434/api/chat',
			expect.objectContaining({ method: 'POST' })
		);
		expect(result.localAiUnavailable).toBe(true);
		expect(result.insights.some((item) => item.source === 'rules')).toBe(true);

		fetchMock.mockRestore();
	});

	it('n’envoie pas de ligne CSV brute complète dans le résumé LLM', () => {
		expect.assertions(2);

		const monthlySummary = summarizeMonthlyBudget(transactions, [], '2026-06');
		const compactSummary = buildTransactionSummary(transactions, monthlySummary);
		const serialized = JSON.stringify(compactSummary);

		expect(serialized).not.toContain(
			'CARTE 4970123412341234 AUCHAN 23/06;Debit;42,10;Reference BP123456789'
		);
		expect(serialized).toContain('transactionCount');
	});

	it('ne contient pas d’identifiant bancaire complet dans le prompt', () => {
		expect.assertions(3);

		const monthlySummary = summarizeMonthlyBudget(
			[
				{
					id: 'iban',
					date: '2026-06-02',
					label: 'VIREMENT FR7612341234123412341234123',
					amountCents: -50_000,
					type: 'expense',
					category: 'Autre',
					source: 'csv'
				}
			],
			[],
			'2026-06'
		);
		const prompt = buildBudgetInsightsPrompt(
			buildTransactionSummary(
				[
					{
						id: 'iban',
						date: '2026-06-02',
						label: 'VIREMENT FR7612341234123412341234123',
						amountCents: -50_000,
						type: 'expense',
						category: 'Autre',
						source: 'csv'
					}
				],
				monthlySummary
			)
		);

		expect(prompt).not.toContain('FR7612341234123412341234123');
		expect(prompt).not.toContain('VIREMENT');
		expect(prompt).toContain('Autre');
	});

	it('conserve les règles déterministes de dépassement de budget', () => {
		expect.assertions(2);

		const monthlySummary = summarizeMonthlyBudget(
			transactions,
			[{ category: 'Logement', limitCents: 90_000 }],
			'2026-06'
		);
		const insights = generateRuleInsights(
			monthlySummary,
			buildTransactionSummary(transactions, monthlySummary)
		);

		expect(insights.some((item) => item.id === 'negative-balance')).toBe(true);
		expect(insights.some((item) => item.id === 'over-budget-logement')).toBe(true);
	});

	it('utilise toutes les transactions income et expense', async () => {
		expect.assertions(3);

		const transactionsWithTransfer = [
			...transactions,
			{
				id: 'transfer',
				date: '2026-06-21',
				label: 'Virement interne',
				amountCents: 50_000,
				type: 'income' as const,
				category: 'Virement interne',
				source: 'banque_populaire' as const
			}
		];
		const monthlySummary = summarizeMonthlyBudget(transactionsWithTransfer, [], '2026-06');
		const result = await getBudgetInsights({
			transactions: transactionsWithTransfer,
			monthlySummary,
			env: { LLM_ENABLED: 'false' }
		});

		expect(result.summary.incomeCents).toBe(150_000);
		expect(result.summary.transactionCount).toBe(transactionsWithTransfer.length);
		expect(monthlySummary.balanceCents).toBe(38_002);
	});

	it('détecte les récurrences à montant similaire via le rapport mensuel', () => {
		expect.assertions(4);

		const monthlySummary = summarizeMonthlyBudget(
			[
				{
					id: 'music-1',
					date: '2026-06-02',
					label: 'ABONNEMENT MUSIQUE 123456',
					amountCents: -999,
					type: 'expense',
					category: 'Loisirs',
					source: 'csv'
				},
				{
					id: 'music-2',
					date: '2026-06-20',
					label: 'ABONNEMENT MUSIQUE 654321',
					amountCents: -1_049,
					type: 'expense',
					category: 'Loisirs',
					source: 'banque_populaire'
				}
			],
			[],
			'2026-06'
		);
		const summary = buildTransactionSummary(
			[
				{
					id: 'music-1',
					date: '2026-06-02',
					label: 'ABONNEMENT MUSIQUE 123456',
					amountCents: -999,
					type: 'expense',
					category: 'Loisirs',
					source: 'csv'
				},
				{
					id: 'music-2',
					date: '2026-06-20',
					label: 'ABONNEMENT MUSIQUE 654321',
					amountCents: -1_049,
					type: 'expense',
					category: 'Loisirs',
					source: 'banque_populaire'
				}
			],
			monthlySummary,
			undefined,
			{ includeLabels: true }
		);

		expect(summary.recurringPayments).toHaveLength(1);
		expect(summary.recurringPayments[0].count).toBe(2);
		expect(summary.recurringPayments[0].label).toBe('Musique - Loisirs');
		expect(summary.recurringPayments[0].label).not.toContain('123456');
	});

	it('signale les dépenses en hausse avec le fallback déterministe', () => {
		expect.assertions(1);

		const monthlySummary = summarizeMonthlyBudget(transactions, [], '2026-06');
		const previousMonth = {
			month: '2026-05',
			incomeCents: 100_000,
			expenseCents: 50_000,
			balanceCents: 50_000,
			categorySummaries: []
		};
		const insights = generateRuleInsights(
			monthlySummary,
			buildTransactionSummary(transactions, monthlySummary, previousMonth)
		);

		expect(insights.some((item) => item.id === 'expenses-increased')).toBe(true);
	});
});
