import { describe, expect, it, vi } from 'vitest';
import { summarizeMonthlyBudget, type CategoryBudget } from '$lib/domain/budget';
import { allocationsOf } from '$lib/domain/allocation';
import { categoryDisplayName } from '$lib/domain/categoryLabels';
import type { Transaction } from '$lib/domain/transaction';
import type { LocalLlmResult } from '$lib/server/insights/types';
import { getEffectiveTransactionNature } from '$lib/server/transactions/nature';
import {
	FIXTURES,
	OUTPUT_ITEMS,
	SIBLING,
	type ModelInsight,
	type SeedTransaction,
	type ShownExpectation
} from './qualification/corpus';
import { createAdmission } from './admission';

/**
 * The output side (G3, #969 and #831) at the gateway's own door: every ruling of the qualification
 * corpus, run in-process. `e2e/ai-qualification.spec.ts` runs the same rulings on the build against
 * a scripted model; this is the fast loop, and the two must agree because both read `expect` from
 * the corpus, which no code computes.
 *
 * The model call is faked, so what it returns is the PARSED answer: the text exactly as the model
 * wrote it, which is what reaches the gateway. Everything the app does to that text happens after.
 */
const llm = vi.hoisted(() => ({
	probeLocalLlm: vi.fn<() => Promise<LocalLlmResult | null>>(async () => null),
	requestLocalBudgetInsights: vi.fn<(prompt: string) => Promise<LocalLlmResult | null>>()
}));
vi.mock('$lib/server/insights/local-llm', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/insights/local-llm')>()),
	...llm
}));

const { createGateway, prepareAdvice } = await import('./gateway');

const ENV = { LLM_ENABLED: 'true', LLM_MODEL: 'fake:g3' } as NodeJS.ProcessEnv;
const MONTH = '2026-06';

function transactionsOf(rows: readonly SeedTransaction[]): Transaction[] {
	return rows.map((row, index) => {
		const amountCents = Math.round(Number(row.amount) * 100);
		return {
			id: `t${index}`,
			date: `${MONTH}-${String(index + 1).padStart(2, '0')}`,
			label: row.label,
			amountCents,
			type: amountCents < 0 ? 'expense' : 'income',
			category: row.category,
			source: 'csv'
		};
	});
}

function periodData(rows: readonly SeedTransaction[], budgets: CategoryBudget[] = []) {
	const transactions = transactionsOf(rows);
	const allocations = transactions.flatMap((transaction) =>
		allocationsOf({
			...transaction,
			nature: getEffectiveTransactionNature(transaction, new Map()).nature
		})
	);
	return {
		transactions,
		allocations,
		budgets,
		summary: summarizeMonthlyBudget(allocations, budgets, MONTH),
		previousSummary: undefined,
		budgetSummaryAvailable: true
	};
}

/** One generation, answered with `written` exactly as a model would have written them. */
async function ask(
	rows: readonly SeedTransaction[],
	written: (prompt: string) => ModelInsight[],
	options: { budgets?: CategoryBudget[]; locale?: string } = {}
) {
	const prepared = prepareAdvice({
		periodData: periodData(rows, options.budgets),
		includeLabels: false,
		env: ENV,
		locale: options.locale ?? 'en'
	});
	llm.requestLocalBudgetInsights.mockImplementationOnce(async (prompt) => ({
		summary: 'Your month at a glance',
		insights: written(prompt).map((insight, index) => ({
			...insight,
			id: `local-llm-${index + 1}`,
			source: 'local-llm'
		}))
	}));
	const admission = createAdmission({ queueDepth: 2, hourlyQuota: 20, now: () => 0 });
	const gateway = createGateway({ admission, now: () => 0 });
	return gateway.generateAdvice({
		userId: 'member',
		prepared,
		epoch: gateway.adviceEpoch('member'),
		signal: new AbortController().signal,
		env: ENV
	});
}

/** The categories whose figures the app shows beside an insight: `figures[].category`. */
function shownOf(insight: Record<string, unknown>): ShownExpectation {
	const figures = Array.isArray(insight.figures) ? insight.figures : [];
	return {
		title: String(insight.title),
		message: String(insight.message),
		severity: insight.severity as ShownExpectation['severity'],
		mentions: figures.map((figure) => String((figure as { category?: unknown }).category))
	};
}

describe('the corpus output rulings, at the gateway (G3: #969, #831)', () => {
	it.each(OUTPUT_ITEMS.map((item) => [item.id, item] as const))('%s', async (_id, item) => {
		const advice = await ask(FIXTURES[item.fixture].transactions, (prompt) => [
			'echoOf' in item.insight
				? {
						title: item.insight.title,
						// The same construction as the e2e suite: 120 characters of the request itself.
						message: prompt.slice(0, 120).trim(),
						severity: 'info',
						category: 'spending'
					}
				: item.insight,
			SIBLING.insight
		]);

		expect(advice.unavailable, 'the answer as a whole was accepted').toBe(false);
		const shown = advice.insights.map((insight) =>
			shownOf(insight as unknown as Record<string, unknown>)
		);
		const sibling = shown.find((s) => s.title === SIBLING.expect.title);
		expect(sibling, 'the sibling renders, so a missing item was dropped, not refused').toEqual(
			SIBLING.expect
		);
		const rest = shown.filter((s) => s !== sibling);
		expect(rest.length, 'at most the item itself beside the sibling').toBeLessThanOrEqual(1);
		expect(rest[0] ?? 'dropped').toEqual('dropped' in item.expect ? 'dropped' : item.expect.shown);
	});
});

const MONTH_EN = FIXTURES['month-en'].transactions;
const plain = (title: string, message: string): ModelInsight => ({
	title,
	message,
	severity: 'info',
	category: 'spending'
});
const WITHHELD = { insights: [], unavailable: true, failureCode: 'response_withheld' };
const at = (codePoint: number) => String.fromCodePoint(codePoint);
const said = async (message: string, rows: readonly SeedTransaction[] = MONTH_EN) =>
	ask(rows, () => [plain('Note', message)]);
const figuresOf = (advice: Awaited<ReturnType<typeof ask>>) =>
	advice.insights.map((insight) => (insight as { figures?: unknown }).figures);

describe('what the corpus does not rule on (G3)', () => {
	it('attaches the figure itself, in cents, beside the category it names', async () => {
		const advice = await ask(MONTH_EN, () => [plain('Groceries', 'Keep Groceries in view.')]);
		expect(figuresOf(advice), '84.20 + 61.10 on Groceries this month').toEqual([
			[{ category: 'Groceries', amountCents: 14_530 }]
		]);
	});

	it('takes the severity from the budget status of the category named, never from the model', async () => {
		// Groceries over its budget, Transport near its limit (42.50 of 50.00 is 85 %), Rent within it.
		const budgets = [
			{ category: 'Groceries', limitCents: 10_000 },
			{ category: 'Transport', limitCents: 5_000 },
			{ category: 'Rent', limitCents: 100_000 }
		];
		const severityOf = async (text: string, written: ModelInsight['severity']) => {
			const advice = await ask(MONTH_EN, () => [{ ...plain('Note', text), severity: written }], {
				budgets
			});
			return advice.insights[0]?.severity;
		};
		expect(await severityOf('Groceries went past their budget.', 'info')).toBe('warning');
		// The worst of the two named: over budget outranks within it.
		expect(await severityOf('Rent and Groceries lead.', 'info')).toBe('warning');
		// The one mapping the rules card uses: only over budget earns a warning.
		expect(await severityOf('Transport is close to its limit.', 'critical')).toBe('info');
		expect(await severityOf('Rent is your largest line.', 'critical')).toBe('info');
		expect(await severityOf('Your month looks steady.', 'warning')).toBe('info');
	});

	it('finds the budget of a category spelt in another case', async () => {
		const advice = await ask(
			MONTH_EN,
			() => [plain('Groceries', 'Groceries went past their budget.')],
			{ budgets: [{ category: 'groceries', limitCents: 10_000 }] }
		);
		expect(advice.insights[0]?.severity).toBe('warning');
	});

	it('says the advice was withheld when every statement was dropped', async () => {
		const advice = await ask(MONTH_EN, () => [
			plain('Rent is high', 'You spent 98765.43 on Rent this month.'),
			plain('Wake up', 'You are an idiot with money.')
		]);
		expect(advice).toEqual(WITHHELD);
	});

	it('keeps an answer with no statement at all as it is: nothing was withheld', async () => {
		expect(await ask(MONTH_EN, () => [])).toEqual({ insights: [], unavailable: false });
	});
});

/**
 * DENY BY DEFAULT (the owner's ruling, 2026-10-11): any number the model writes drops the statement.
 * The calibration of each case is that the same sentence without its number is shown.
 */
describe('the model writes no number (G3)', () => {
	it.each([
		['Rent came to 850 this month.', 'a correct figure, in digits'],
		[`Rent came to 850${at(0xb2)} this month.`, 'a superscript, which NFKC folds to a digit'],
		[`Rent rose by ${at(0xbd)} this month.`, 'a vulgar fraction, which NFKC spells with digits'],
		[`Rent came to ${at(0x0bf0)} this month.`, 'a numeric character with no digit value'],
		['Rent takes a large % of spending.', 'a percent sign alone'],
		['Rent came to eight hundred this month.', 'a magnitude word'],
		['Rent takes forty per cent of spending.', 'a percentage in words'],
		['Le Loyer atteint huit cents ce mois-ci.', 'a magnitude word in French'],
		['Le Loyer pèse quarante pour cent des dépenses.', 'a French percentage in words'],
		['Top 5 gifts is your only line.', 'a digit inside what may be a category name']
	])('drops « %s » (%s)', async (message) => {
		expect(await said(message)).toEqual(WITHHELD);
	});

	it.each([
		['Rent stays your largest line this month.'],
		['Rent is one of your lines.'],
		['Le Loyer reste votre première dépense.']
	])('keeps « %s »', async (message) => {
		expect((await said(message)).insights).toHaveLength(1);
	});
});

/**
 * The pass on deny-first (2026-10-11): a number in words or in a symbol. Two closed lists answer it:
 * the characters a statement may use, and the number words of the card's two languages.
 */
describe('a number in words or symbols, and the characters a statement may use (G3)', () => {
	it.each([
		['Rent came to ninety-nine euros.', 'English number words'],
		['Le Loyer a coûté quatre-vingt-dix-neuf euros.', 'French number words'],
		['Rent is half your spending.', 'a ratio word'],
		[
			`Rent came to ${at(0x216b)} euros.`,
			'a Roman numeral character, which NFKC turns into letters'
		],
		['Rent came to DCCC euros.', 'a Roman numeral in letters'],
		[`Rent came to ${at(0x516b)}${at(0x767e)} euros.`, 'Han numerals, which are letters'],
		[`Rent came to ${at(0x3287)} euros.`, 'a circled Han numeral'],
		[`Rent came to ${at(0x1f4af)} euros.`, 'an emoji that reads as a number'],
		[`Rent came to ${at(0x1f51f)} euros.`, 'a keycap ten'],
		[`Rent came to eight hundr${at(0x0435)}d euros.`, 'a Cyrillic letter that looks Latin'],
		[`Rent came to deux M${at(0x0130)}LLE euros.`, 'a dotted capital I that lowercases apart'],
		[`Rent takes a large ${at(0x066a)} of spending.`, 'the Arabic percent sign'],
		[`Rent stays${at(0x2800)}steady.`, 'a blank that is a symbol'],
		['<b>Rent</b> stays steady.', 'markup']
	])('drops « %s » (%s)', async (message) => {
		expect(await said(message)).toEqual(WITHHELD);
	});

	it.each([
		['Rent is one of your lines.'],
		['Groceries are your second largest line this month.'],
		["L'épicerie reste à surveiller, comme le Loyer."]
	])('keeps « %s »', async (message) => {
		expect((await said(message)).insights).toHaveLength(1);
	});
});

describe('the guards the character list does not cover (G3)', () => {
	// A category name brings its digits onto the list of allowed characters; the digit rule still
	// refuses them in the model's text.
	it('drops a digit even when a category name makes it an allowed character', async () => {
		const rows = [...MONTH_EN, { label: 'STORAGE', amount: '-100.00', category: 'Box 850' }];
		expect(await said('Rent came to 850 this month.', rows)).toEqual(WITHHELD);
	});

	// Only the folded pattern holds « prêt »: the English lists have no twin for it.
	it('reads an accented product word through the same folding as the text', async () => {
		expect(await said('Contractez un prêt pour vos travaux.')).toEqual(WITHHELD);
	});

	// A line break is not an allowed character, so without the collapse this statement is dropped.
	it('shows a statement the model broke over two lines, on one line', async () => {
		const advice = await said('Groceries stay\nsteady this month.');
		expect(advice.insights.map((insight) => insight.message)).toEqual([
			'Groceries stay steady this month.'
		]);
	});
});

/**
 * The pass on the allow-list (2026-10-11): « the Latin script » was not narrow. The letters are now
 * each language's own (`cardLanguages.ts`), the number words compose, and no currency sign is
 * allowed, since no amount may be written.
 */
describe('the alphabet of the card, and number words that compose (G3)', () => {
	it.each([
		[`Groceries reached ${at(0x01bc)}OO this month.`, 'a Latin letter drawn like a 5'],
		['Groceries reached IOO this month.', 'capital I and O drawn like 100'],
		[`Groceries reached f${at(0x0131)}ve this month.`, 'a dotless i inside a number word'],
		[`Groceries reached ${at(0xa730)}orty this month.`, 'a small capital F'],
		[
			`Groceries reached fi${at(0x1ab0)}ve this month.`,
			'a combining mark outside the folded block'
		],
		['Vos Courses ont atteint septante.', 'a Belgian and Swiss number word'],
		['Groceries could reach a trillion.', 'trillion'],
		['Groceries went up tenfold.', 'a multiplier built on a number word'],
		['Groceries reached fortyfive this month.', 'number words written together'],
		['Les Courses font dixsept fois le Loyer.', 'French number words written together'],
		['Les Courses font un dixième des dépenses.', 'a French fraction'],
		['Groceries take a third of your spending.', 'an English fraction'],
		['Groceries quadrupled this month.', 'a multiplier verb'],
		['Groceries are paid in €.', 'a currency sign, with no amount allowed'],
		['Groceries cost a few euros more.', 'a currency word']
	])('drops « %s » (%s)', async (message) => {
		expect(await said(message)).toEqual(WITHHELD);
	});

	it.each([
		['Rent stays your first line this month.'],
		['Often, Rent leads the month.'],
		['Le centre-ville rend le Loyer cher.'],
		['Rien ne change en septembre pour le Loyer.'],
		['La Santé reste neuve dans le budget.']
	])('keeps « %s »', async (message) => {
		expect((await said(message)).insights).toHaveLength(1);
	});
});

/** The checks read the SHOWN text: what the markdown and the invisible characters hid is found. */
describe('every rule reads the shown text (G3)', () => {
	it.each([
		['Buy B`itcoin` with what is left.', 'a code span inside the product'],
		['You are an id**iot** with money.', 'emphasis inside the insult'],
		['Write to help@example`.com`.', 'a code span inside the address'],
		[`You are an id${at(0x034f)}iot with money.`, 'a combining grapheme joiner inside the insult'],
		[`Buy B${at(0xfe0f)}itcoin with what is left.`, 'a variation selector inside the product'],
		[`You are an id${at(0x200c)}iot with money.`, 'a ZWNJ inside the insult'],
		['Buy\nBitcoin with what is left.', 'a line break inside the phrase']
	])('drops « %s » (%s)', async (message) => {
		expect(await said(message)).toEqual(WITHHELD);
	});

	it('reads the title and the message as one text, whichever comes first', async () => {
		expect(await ask(MONTH_EN, () => [plain('Index funds', 'Buy one every month.')])).toEqual(
			WITHHELD
		);
		expect(await said('ETF: buy one every month.')).toEqual(WITHHELD);
		expect(await said('An index fund is the place to put your savings.')).toEqual(WITHHELD);
		expect(await said('Consider an ETF for what is left.')).toEqual(WITHHELD);
		expect(await said('As a practising Catholic, you may be giving more.')).toEqual(WITHHELD);
	});
});

describe('the names beside which a figure is shown (G3)', () => {
	it('attaches nothing for names that differ only by case once cleaned', async () => {
		const rows = [
			{ label: 'STALL', amount: '-12.00', category: 'Market' },
			{ label: 'HALL', amount: '-30.00', category: 'ＭＡＲＫＥＴ' },
			{ label: 'EMPLOYER', amount: '2100.00', category: 'Salary' }
		];
		expect(figuresOf(await said('Market is a steady line.', rows))).toEqual([[]]);
	});

	it('attaches the cleaned name, never a direction character', async () => {
		const rows = [
			{ label: 'SHOP', amount: '-12.34', category: `Books${at(0x202e)}` },
			{ label: 'EMPLOYER', amount: '2100.00', category: 'Salary' }
		];
		expect(figuresOf(await said('Books stay small.', rows))).toEqual([
			[{ category: 'Books', amountCents: 1_234 }]
		]);
	});

	it('ignores a name cleaned to nothing, and still answers', async () => {
		const rows = [
			{ label: 'SHOP', amount: '-12.00', category: at(0x200b) },
			{ label: 'LANDLORD', amount: '-850.00', category: 'Rent' },
			{ label: 'EMPLOYER', amount: '2100.00', category: 'Salary' }
		];
		expect(figuresOf(await said('Rent stays steady.', rows))).toEqual([
			[{ category: 'Rent', amountCents: 85_000 }]
		]);
	});

	it('names a category only as a whole word', async () => {
		expect(figuresOf(await said('Rental offers stay out of view.'))).toEqual([[]]);
	});

	it('keeps a ZWNJ inside a word, which Persian spelling needs, and still finds the name', async () => {
		const name = `کتاب${at(0x200c)}خانه`;
		const rows = [
			{ label: 'SHOP', amount: '-13.00', category: name },
			{ label: 'EMPLOYER', amount: '2100.00', category: 'Salary' }
		];
		const advice = await ask(rows, () => [plain(name, `${name} stays small.`)]);
		expect(advice.insights.map((i) => i.title)).toEqual([name]);
		expect(figuresOf(advice)).toEqual([[{ category: name, amountCents: 1_300 }]]);
	});

	it('reads the longest name first, so a longer name is not taken for a shorter one', async () => {
		const rows = [
			{ label: 'LANDLORD', amount: '-850.00', category: 'Rent' },
			{ label: 'GARAGE', amount: '-40.00', category: 'Rent extras' },
			{ label: 'EMPLOYER', amount: '2100.00', category: 'Salary' }
		];
		const advice = await ask(rows, () => [plain('Extras', 'Rent extras stay small.')]);
		expect(figuresOf(advice)).toEqual([[{ category: 'Rent extras', amountCents: 4_000 }]]);
	});

	it('reads the displayed name of the uncategorized line as its name', async () => {
		const rows = [
			{ label: 'SHOP', amount: '-30.00', category: 'uncategorized' },
			{ label: 'LANDLORD', amount: '-850.00', category: 'Rent' },
			{ label: 'EMPLOYER', amount: '2100.00', category: 'Salary' }
		];
		const shown = categoryDisplayName('uncategorized');
		expect(shown, 'the calibration: a displayed name that differs').not.toBe('uncategorized');
		expect(figuresOf(await said(`${shown} stays small.`, rows))).toEqual([
			[{ category: 'uncategorized', amountCents: 3_000 }]
		]);
	});
});

describe('the order at the gateway (G3)', () => {
	// Accepted before the cache write, versus a cache hit serving a statement the app refused.
	it('serves from the cache only what it accepted', async () => {
		const prepared = prepareAdvice({
			periodData: periodData(MONTH_EN),
			includeLabels: false,
			env: ENV,
			locale: 'en'
		});
		llm.requestLocalBudgetInsights.mockImplementationOnce(async () => ({
			summary: 's',
			insights: [
				{ ...plain('Wake up', 'You are an idiot with money.'), id: 'a', source: 'local-llm' },
				{ ...SIBLING.insight, id: 'b', source: 'local-llm' }
			]
		}));
		const admission = createAdmission({ queueDepth: 2, hourlyQuota: 20, now: () => 0 });
		const gateway = createGateway({ admission, now: () => 0 });
		const once = () =>
			gateway.generateAdvice({
				userId: 'member',
				prepared,
				epoch: gateway.adviceEpoch('member'),
				signal: new AbortController().signal,
				env: ENV
			});
		const calls = llm.requestLocalBudgetInsights.mock.calls.length;
		const first = await once();
		const second = await once();
		expect(llm.requestLocalBudgetInsights.mock.calls.length - calls, 'one generation').toBe(1);
		expect(first.insights.map((i) => i.title)).toEqual([SIBLING.expect.title]);
		expect(second, 'the cache hit').toEqual(first);
	});
});

/** The narrow pass on the code fixes (2026-10-11). Same month: expenses 1091.70. */
