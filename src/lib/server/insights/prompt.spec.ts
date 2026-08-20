import { describe, expect, it } from 'vitest';
import { buildBudgetInsightsPrompt, toPromptPayload } from './prompt';
import type { TransactionSummary } from './types';

const summary: TransactionSummary = {
	period: '2026-06',
	incomeCents: 245_000,
	expenseCents: 151_487,
	balanceCents: 93_513,
	transactionCount: 15,
	topCategories: [
		{ category: 'Logement', amountCents: -95_000, transactionCount: 1, percentageOfExpenses: 62 }
	],
	largestExpenses: [
		{ label: 'Loyer', amountCents: -95_000, category: 'Logement', splitIndicator: null }
	],
	recurringPayments: [
		{
			id: 'tx-spotify-2',
			label: 'Spotify',
			amountCents: -1_099,
			totalAmountCents: -2_198,
			count: 2,
			category: 'Loisirs',
			lastDate: '2026-06-10',
			confidence: 'haute'
		}
	],
	previousMonth: {
		month: '2026-05',
		incomeDeltaCents: 0,
		expenseDeltaCents: 15_000,
		balanceDeltaCents: -15_000
	}
};

describe('toPromptPayload', () => {
	it('converts every *Cents field to euros and drops the suffix', () => {
		const payload = toPromptPayload(summary) as Record<string, unknown>;

		expect(payload.income).toBe(2450);
		expect(payload.expense).toBe(1514.87);
		expect(payload.balance).toBe(935.13);
		expect(payload).not.toHaveProperty('incomeCents');
		expect(payload).not.toHaveProperty('expenseCents');
		expect(payload).not.toHaveProperty('balanceCents');
	});

	it('converts nested arrays and objects too', () => {
		const payload = toPromptPayload(summary) as {
			topCategories: { amount: number }[];
			largestExpenses: { amount: number }[];
			recurringPayments: { amount: number; totalAmount: number }[];
			previousMonth: { expenseDelta: number; balanceDelta: number };
		};

		expect(payload.topCategories[0].amount).toBe(-950);
		expect(payload.largestExpenses[0].amount).toBe(-950);
		expect(payload.recurringPayments[0].amount).toBe(-10.99);
		expect(payload.recurringPayments[0].totalAmount).toBe(-21.98);
		expect(payload.previousMonth.expenseDelta).toBe(150);
		expect(payload.previousMonth.balanceDelta).toBe(-150);
	});

	it('leaves non-monetary fields untouched', () => {
		const payload = toPromptPayload(summary) as Record<string, unknown>;

		expect(payload.period).toBe('2026-06');
		expect(payload.transactionCount).toBe(15);
		expect((payload.recurringPayments as { confidence: string }[])[0].confidence).toBe('haute');
		expect((payload.previousMonth as { month: string }).month).toBe('2026-05');
	});

	it('does not convert a *Cents key whose value is not a number', () => {
		expect(toPromptPayload({ amountCents: null })).toEqual({ amountCents: null });
	});

	it('converts a nested splitIndicator.parts array (the allocation breakdown) to euros', () => {
		const withSplit: TransactionSummary = {
			...summary,
			largestExpenses: [
				{
					label: 'Loyer',
					amountCents: -95_000,
					category: 'Logement',
					splitIndicator: {
						dominantCategory: 'Logement',
						dominantNature: 'spending',
						otherCategoryCount: 1,
						partCount: 2,
						parts: [
							{ category: 'Assurance', amountCents: -20_000 },
							{ category: 'Logement', amountCents: -75_000 }
						]
					}
				}
			]
		};

		const payload = toPromptPayload(withSplit) as {
			largestExpenses: {
				splitIndicator: { dominantCategory: string; parts: { category: string; amount: number }[] };
			}[];
		};

		expect(payload.largestExpenses[0].splitIndicator.dominantCategory).toBe('Logement');
		expect(payload.largestExpenses[0].splitIndicator.parts).toEqual([
			{ category: 'Assurance', amount: -200 },
			{ category: 'Logement', amount: -750 }
		]);
	});
});

describe('buildBudgetInsightsPrompt', () => {
	it('never leaks a raw cents amount into the prompt', () => {
		const prompt = buildBudgetInsightsPrompt(summary, { locale: 'en' });

		// The exact figures that produced "245000 - 151487 = 93513 dollars" in real output.
		expect(prompt).not.toContain('245000');
		expect(prompt).not.toContain('151487');
		expect(prompt).not.toContain('93513');
		expect(prompt).not.toContain('Cents');
	});

	it('states the currency both in the instructions and in the payload', () => {
		const prompt = buildBudgetInsightsPrompt(summary, { locale: 'en' });

		expect(prompt).toContain('euros (EUR)');
		expect(prompt).toContain('"currency":"EUR"');
	});

	it('carries the converted amounts', () => {
		const prompt = buildBudgetInsightsPrompt(summary, { locale: 'en' });

		expect(prompt).toContain('"income":2450');
		expect(prompt).toContain('"expense":1514.87');
	});

	it('asks for the reply in the caller’s locale', () => {
		expect(buildBudgetInsightsPrompt(summary, { locale: 'fr' })).toContain('Reply in French.');
		expect(buildBudgetInsightsPrompt(summary, { locale: 'en' })).toContain('Reply in English.');
	});

	it('falls back to English for an unknown locale', () => {
		expect(buildBudgetInsightsPrompt(summary, { locale: 'de' })).toContain('Reply in English.');
	});
});

/**
 * #216: the data-description sentence must match whether labels are actually shared, and it must do
 * so INDEPENDENTLY of the reply-language branch — the conditional lives one line above the payload
 * and could easily be entangled with the locale. Running both locales separates "the includeLabels
 * branch works" from "it works only in English"; a break that tied the sentence to the locale would
 * pass a single-locale test and fail here.
 *
 * These assert on the SOURCE function directly; the payload actually delivered to the model is
 * captured end-to-end in index.spec.ts, which is the only thing that proves getBudgetInsights threads
 * the flag through at all.
 */
describe('buildBudgetInsightsPrompt data-description sentence, both locales (#216)', () => {
	const AGGREGATED = 'Aggregated data, no raw transactions';
	const WITH_LABELS = 'Aggregated data plus your largest transaction labels';

	for (const locale of ['en', 'fr']) {
		it(`says aggregated-only when labels are off (${locale})`, () => {
			const prompt = buildBudgetInsightsPrompt(summary, { includeLabels: false, locale });

			expect(prompt).toContain(AGGREGATED);
			expect(prompt).not.toContain(WITH_LABELS);
		});

		it(`says labels-are-included when labels are on (${locale})`, () => {
			const prompt = buildBudgetInsightsPrompt(summary, { includeLabels: true, locale });

			expect(prompt).toContain(WITH_LABELS);
			// The two sentences share the "Aggregated data" stem, so the off-phrase's absence is the
			// real discriminator: without it, a sentence carrying both would pass the line above.
			expect(prompt).not.toContain(AGGREGATED);
		});
	}

	it('omitting includeLabels defaults to the safe aggregated-only claim', () => {
		const prompt = buildBudgetInsightsPrompt(summary, { locale: 'en' });

		expect(prompt).toContain(AGGREGATED);
		expect(prompt).not.toContain(WITH_LABELS);
	});
});
