import { describe, expect, it } from 'vitest';
import { buildBudgetInsightsPrompt, toPromptPayload } from './prompt';
import type { AssertPromptSafe, TransactionSummary } from './types';

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

describe('the account fields that must never reach the local model', () => {
	// #466's neighbour, and the reason this exists at all: `toPromptPayload` is an
	// ALLOW-EVERYTHING walker. It recurses into every array and object and passes every key
	// through, transforming only `*Cents`. There is no allowlist and no denylist, so today the
	// only thing between `Account.discriminant` and the model is that no account object is in
	// `TransactionSummary`. That is an ABSENCE, not a control, and the identical shape already
	// leaked a raw transaction id through a `...payment` spread (see types.ts).
	//
	// A partial bank account identifier is a new sensitive data class: at most four characters
	// from the end of an IBAN, and in a list of one holder's accounts it is precisely the
	// attribute that identifies. ASVS 5.0.0 14.1.1 carries it, 16.2.5 is the logging interdict,
	// and 14.2.3 (verified by attack, as of the 2026-08-13 assessment of commit d9c116c) is the
	// row about sensitive data reaching untrusted parties.
	it('refuses a payload carrying an account fragment, at any depth', () => {
		// SEPARATES: « the walker refuses a forbidden key nested two levels down » FROM « the
		// walker only inspects the top level ». The fragment is placed inside
		// `largestExpenses[0]`, not on the payload root, because a top-level-only guard would be
		// narrower than the walker it guards and would pass a root-level test.
		const leaked = {
			...summary,
			largestExpenses: [{ ...summary.largestExpenses[0], discriminant: '4417' }]
		} as unknown as TransactionSummary;

		expect(() => buildBudgetInsightsPrompt(leaked)).toThrow(/discriminant/i);
	});

	it('does not name the fragment in the refusal, because an error message travels', () => {
		// SEPARATES: « the refusal names the key and deliberately omits the value » FROM « some
		// other error was thrown, which also happens not to contain 4417 ». Those are the same
		// green under a bare `not.toContain`, so the positive claim is asserted first: the message
		// must name `discriminant`. A break-check would redden either way and tell us nothing
		// about which of the two we are in.
		expect.assertions(3);

		const leaked = {
			...summary,
			largestExpenses: [{ ...summary.largestExpenses[0], discriminant: '4417' }]
		} as unknown as TransactionSummary;

		try {
			buildBudgetInsightsPrompt(leaked);
		} catch (error) {
			const message = (error as Error).message;
			// The KEY is named, so a developer can find the field.
			expect(message).toContain('discriminant');
			// The VALUE is not: an error message reaches a log, a screenshot, a ticket and a
			// clipboard. ASVS 5.0.0 16.2.5.
			expect(message).not.toContain('4417');
			// And it is OUR refusal rather than an incidental throw from somewhere downstream.
			expect(message).toContain('refusing to build a prompt');
		}
	});

	it('still builds an ordinary payload, and the control string proves it read one', () => {
		// SEPARATES: « the prompt was built and carries no forbidden key » FROM « the builder
		// returned nothing, so of course it carries no forbidden key ». The control string is the
		// only thing that tells those two apart.
		const prompt = buildBudgetInsightsPrompt(summary);
		// THE CONTROL. Without it, "no fragment in the prompt" is equally true of a builder that
		// returned an empty string, and an empty result would read as a clean pass.
		expect(prompt).toContain('"period":"2026-06"');
		expect(prompt).not.toContain('discriminant');
	});
});

/**
 * THE TYPE-LEVEL CALIBRATION, and it is the half that proves the guard is a guard.
 *
 * `AssertPromptSafe<TransactionSummary>` resolving to `true` is equally consistent with the type
 * WORKING and with it being vacuous, exactly the way a green property test is consistent with a
 * generator that cannot reach the failing shape. So the type is pointed at a payload that MUST be
 * refused, and `@ts-expect-error` is what asserts the refusal: if the type ever stops rejecting,
 * the unused-directive error fails `npm run check` rather than passing quietly.
 *
 * Type-level only. There is nothing to run here, which is why it lives beside the runtime tests
 * rather than pretending to be one.
 */
type PayloadWithAccountFragment = TransactionSummary & {
	largestExpenses: (TransactionSummary['largestExpenses'][number] & { discriminant: string })[];
};

// @ts-expect-error the payload reaches a refused key (`discriminant`) at depth 2, so this must not
// be assignable to `true`. Removing the guard, or narrowing it to the top level, turns this line
// into an unused-directive error.
const _nestedFragmentIsRefused: AssertPromptSafe<PayloadWithAccountFragment> = true;
void _nestedFragmentIsRefused;

type PayloadWithRawIdentifier = TransactionSummary & { accountId: string };

// @ts-expect-error a raw identifier at the top level is refused for the recorded reason: the prompt
// declares itself as carrying no raw transactions, and an identifier makes that sentence false.
const _topLevelIdentifierIsRefused: AssertPromptSafe<PayloadWithRawIdentifier> = true;
void _topLevelIdentifierIsRefused;
