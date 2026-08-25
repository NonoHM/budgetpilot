import { describe, expect, it, vi } from 'vitest';
import { summarizeMonthlyBudget } from '$lib/domain/budget';
import type { Transaction } from '$lib/domain/transaction';
import { allocationsOf, type CategoryAllocation } from '$lib/domain/allocation';
import { getEffectiveTransactionNature } from '$lib/server/transactions/nature';
import { getBudgetInsights } from './index';
import { buildBudgetInsightsPrompt } from './prompt';
import { generateRuleInsights } from './rules';
import { buildTransactionSummary } from './summary';

/**
 * Derives the MONEY view from the fixture's IDENTITY view, by calling the canonical helpers rather
 * than restating the remainder rule or the nature default (see CLAUDE.md). Every fixture in this
 * file is unsplit, so this always yields exactly one allocation per transaction, carrying its
 * whole amount.
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

		const allocations = toAllocations(transactions);
		const monthlySummary = summarizeMonthlyBudget(allocations, [], '2026-06');
		const result = await getBudgetInsights({
			transactions,
			allocations,
			monthlySummary,
			env: { LLM_ENABLED: 'false' }
		});

		expect(result.localAiUnavailable).toBe(false);
		expect(result.insights.some((item) => item.id === 'negative-balance')).toBe(true);
		expect(result.insights.every((item) => item.source === 'rules')).toBe(true);
	});

	it('garde le fallback si Ollama est indisponible', async () => {
		expect.assertions(4);

		const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
		const allocations = toAllocations(transactions);
		const monthlySummary = summarizeMonthlyBudget(allocations, [], '2026-06');
		const result = await getBudgetInsights({
			transactions,
			allocations,
			monthlySummary,
			env: {
				LLM_ENABLED: 'true',
				LLM_PROVIDER: 'ollama',
				LLM_BASE_URL: 'http://127.0.0.1:11434',
				LLM_MODEL: 'qwen2.5:0.5b',
				LLM_TIMEOUT_MS: '10'
			}
		});

		// The CONNECT PROBE, not the generation, and that is the behaviour change #524 shipped: an
		// Ollama that is not running is refused on `/api/version` inside the connect budget, so the
		// generation budget is never opened at all. Asserting the probe URL rather than merely that
		// some fetch happened is what separates "gave up at connect" from "waited on generation",
		// which are the two states the whole fix is about.
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:11434/api/version',
			expect.objectContaining({ method: 'GET' })
		);
		expect(
			fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.endsWith('/api/chat'))
		).toEqual([]);
		expect(result.localAiUnavailable).toBe(true);
		expect(result.insights.some((item) => item.source === 'rules')).toBe(true);

		fetchMock.mockRestore();
	});

	it('n’envoie pas de ligne CSV brute complète dans le résumé LLM', () => {
		expect.assertions(2);

		const allocations = toAllocations(transactions);
		const monthlySummary = summarizeMonthlyBudget(allocations, [], '2026-06');
		const compactSummary = buildTransactionSummary(transactions, allocations, monthlySummary);
		const serialized = JSON.stringify(compactSummary);

		expect(serialized).not.toContain(
			'CARTE 4970123412341234 AUCHAN 23/06;Debit;42,10;Reference BP123456789'
		);
		expect(serialized).toContain('transactionCount');
	});

	it('ne contient pas d’identifiant bancaire complet dans le prompt', () => {
		expect.assertions(3);

		const ibanTransactions: Transaction[] = [
			{
				id: 'iban',
				date: '2026-06-02',
				label: 'VIREMENT FR7612341234123412341234123',
				amountCents: -50_000,
				type: 'expense',
				category: 'Autre',
				source: 'csv'
			}
		];
		const ibanAllocations = toAllocations(ibanTransactions);
		const monthlySummary = summarizeMonthlyBudget(ibanAllocations, [], '2026-06');
		const prompt = buildBudgetInsightsPrompt(
			buildTransactionSummary(ibanTransactions, ibanAllocations, monthlySummary)
		);

		expect(prompt).not.toContain('FR7612341234123412341234123');
		expect(prompt).not.toContain('VIREMENT');
		expect(prompt).toContain('Autre');
	});

	it('conserve les règles déterministes de dépassement de budget', () => {
		expect.assertions(2);

		const allocations = toAllocations(transactions);
		const monthlySummary = summarizeMonthlyBudget(
			allocations,
			[{ category: 'Logement', limitCents: 90_000 }],
			'2026-06'
		);
		const insights = generateRuleInsights(
			monthlySummary,
			buildTransactionSummary(transactions, allocations, monthlySummary)
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
		const allocationsWithTransfer = toAllocations(transactionsWithTransfer);
		const monthlySummary = summarizeMonthlyBudget(allocationsWithTransfer, [], '2026-06');
		const result = await getBudgetInsights({
			transactions: transactionsWithTransfer,
			allocations: allocationsWithTransfer,
			monthlySummary,
			env: { LLM_ENABLED: 'false' }
		});

		expect(result.summary.incomeCents).toBe(150_000);
		expect(result.summary.transactionCount).toBe(transactionsWithTransfer.length);
		expect(monthlySummary.balanceCents).toBe(38_002);
	});

	it('détecte les récurrences à montant similaire via le rapport mensuel', () => {
		expect.assertions(4);

		const musicTransactions: Transaction[] = [
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
		];
		const musicAllocations = toAllocations(musicTransactions);
		const monthlySummary = summarizeMonthlyBudget(musicAllocations, [], '2026-06');
		const summary = buildTransactionSummary(
			musicTransactions,
			musicAllocations,
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

		const allocations = toAllocations(transactions);
		const monthlySummary = summarizeMonthlyBudget(allocations, [], '2026-06');
		const previousMonth = {
			month: '2026-05',
			incomeCents: 100_000,
			expenseCents: 50_000,
			balanceCents: 50_000,
			categorySummaries: []
		};
		const insights = generateRuleInsights(
			monthlySummary,
			buildTransactionSummary(transactions, allocations, monthlySummary, previousMonth)
		);

		expect(insights.some((item) => item.id === 'expenses-increased')).toBe(true);
	});
});

/**
 * #216: the prompt's own sentence claimed "no raw transactions" even when the aiIncludeLabels opt-in
 * sent the largest-expense merchant labels to the model. The fix threads includeLabels through
 * getBudgetInsights into the sentence.
 *
 * These tests separate the two states that matter, which reading the source constant (or calling
 * buildBudgetInsightsPrompt directly with an explicit flag) cannot: "the sentence in the source
 * changed" versus "the sentence that REACHES THE MODEL changed". The actual defect lived in the
 * assembly (index.ts did not pass the flag), so the observation has to be the payload the model
 * receives. We capture it the way the pentest did: off the fetch the Ollama client ultimately calls.
 */
describe('AI prompt truthfulness: the sentence matches the shared payload (#216)', () => {
	// A distinctive merchant token that survives anonymization ("Auchan"), on an expense big enough to
	// land in largestExpenses. The CATEGORY ("Logement") is deliberately not the discriminator: it
	// leaks into the payload via topCategories REGARDLESS of the toggle, so only the merchant token
	// tells labels-on from labels-off. Keying an assertion on the category would separate neither state.
	const labelFixture: Transaction[] = [
		{
			id: 'income',
			date: '2026-06-01',
			label: 'Salaire',
			amountCents: 300_000,
			type: 'income',
			category: 'Revenus',
			source: 'manual'
		},
		{
			id: 'auchan',
			date: '2026-06-02',
			label: 'CARTE AUCHAN PARIS 23/06',
			amountCents: -120_000,
			type: 'expense',
			category: 'Logement',
			source: 'banque_populaire'
		}
	];

	const MERCHANT_TOKEN = 'Auchan';
	const ANONYMIZED_LABEL = 'Expense';
	const AGGREGATED = 'Aggregated data, no raw transactions';
	const WITH_LABELS = 'Aggregated data plus your largest transaction labels';

	/**
	 * Returns the exact prompt string the model would receive. The Ollama client's fetch is spied on,
	 * the /api/chat body is read, and the request is then aborted: requestLocalBudgetInsights swallows
	 * the failure, and by then the prompt has already been assembled and captured. Going through
	 * getBudgetInsights is the point: a test that called buildBudgetInsightsPrompt directly would pass
	 * even if the assembly dropped the flag, which is exactly the bug.
	 */
	async function captureModelPrompt(includeLabels: boolean): Promise<string> {
		let captured: string | null = null;
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			// The connect probe runs first and carries no body (#524). Answering it here rather than
			// letting it fall into the capture is what keeps this helper measuring the PROMPT: parsing
			// the probe's absent body throws before the generation is ever assembled, and the helper
			// then reports "fetch was never called" while fetch had in fact been called once.
			const url =
				typeof input === 'string'
					? input
					: input instanceof URL
						? input.href
						: (input as Request).url;
			if (url.endsWith('/api/version')) {
				return new Response(JSON.stringify({ version: '0.32.5' }), { status: 200 });
			}
			const body = JSON.parse(String((init as RequestInit).body)) as {
				messages: { content: string }[];
			};
			captured = body.messages[0].content;
			throw new Error('captured: aborting the real round trip');
		});

		try {
			const allocations = toAllocations(labelFixture);
			const monthlySummary = summarizeMonthlyBudget(allocations, [], '2026-06');
			await getBudgetInsights({
				transactions: labelFixture,
				allocations,
				monthlySummary,
				includeLabels,
				env: {
					LLM_ENABLED: 'true',
					LLM_PROVIDER: 'ollama',
					LLM_BASE_URL: 'http://127.0.0.1:11434',
					LLM_MODEL: 'qwen2.5:0.5b',
					LLM_TIMEOUT_MS: '1000'
				}
			});
		} finally {
			fetchMock.mockRestore();
		}

		if (captured === null) throw new Error('fetch was never called: the prompt was not captured');
		return captured;
	}

	/** Parses the JSON payload embedded at the tail of the prompt (its `{"currency"...}` line). */
	function payloadOf(prompt: string): { largestExpenses: { label: string }[] } {
		const start = prompt.indexOf('{"currency"');
		return JSON.parse(prompt.slice(start)) as { largestExpenses: { label: string }[] };
	}

	it('labels off: the sentence claims aggregated-only and the payload carries no merchant label', async () => {
		expect.assertions(4);
		const prompt = await captureModelPrompt(false);

		expect(prompt).toContain(AGGREGATED);
		expect(prompt).not.toContain(WITH_LABELS);
		// The merchant never leaves the process; every largest-expense label is the placeholder.
		expect(prompt).not.toContain(MERCHANT_TOKEN);
		expect(payloadOf(prompt).largestExpenses.every((e) => e.label === ANONYMIZED_LABEL)).toBe(true);
	});

	it('labels on: the sentence says labels are included and the payload actually carries them', async () => {
		expect.assertions(4);
		const prompt = await captureModelPrompt(true);

		expect(prompt).toContain(WITH_LABELS);
		// Shared "Aggregated data" stem, so the off-phrase's absence is the real discriminator.
		expect(prompt).not.toContain(AGGREGATED);
		// The real merchant now reaches the model, exactly what the sentence now admits.
		expect(prompt).toContain(MERCHANT_TOKEN);
		expect(payloadOf(prompt).largestExpenses.some((e) => e.label.includes(MERCHANT_TOKEN))).toBe(
			true
		);
	});

	it('the sentence and the payload agree in both directions, which is the whole defect', async () => {
		expect.assertions(2);
		const off = await captureModelPrompt(false);
		const on = await captureModelPrompt(true);

		// Before the fix the sentence was fixed at "no raw transactions" while the payload's merchant
		// presence tracked the toggle. The invariant that closes #216: the sentence admits labels if
		// and only if the payload actually carries a merchant label.
		expect(off.includes(WITH_LABELS)).toBe(off.includes(MERCHANT_TOKEN));
		expect(on.includes(WITH_LABELS)).toBe(on.includes(MERCHANT_TOKEN));
	});
});
