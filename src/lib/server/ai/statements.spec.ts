import { afterEach, describe, expect, it, vi } from 'vitest';
import { summarizeMonthlyBudget, type CategoryBudget } from '$lib/domain/budget';
import { allocationsOf } from '$lib/domain/allocation';
import type { Transaction } from '$lib/domain/transaction';
import { getEffectiveTransactionNature } from '$lib/server/transactions/nature';
import { createAdmission } from './admission';
import { createGateway, prepareAdvice } from './gateway';

/**
 * THE RULING OF #996, at the model's own HTTP door: the model picks a statement kind and a category
 * alias, never words; the app shows a pick only when it can recompute the fact as true, and the card
 * writes every sentence. Owner's delegation of 2026-10-11, recorded on #996.
 *
 * Nothing is faked but Ollama's HTTP answer, so the parse, the gateway and the acceptance are the
 * production ones: a test that built the parsed answer itself would measure that acceptance is
 * POSSIBLE, not that the path performs it.
 *
 * Synthetic month of Paul Mercier, who does not exist. Top five, in payload order:
 * c1 Rent 850.00 (no budget), c2 Groceries 145.30 (budget 100: over), c3 Transport 42.50 (budget 50:
 * near the limit), c4 Streaming 19.98 (twice: recurring, no budget), c5 Health 18.90 (budget 100: ok).
 * Income 2100.00; the previous month spent 1000.00, so spending went up and stayed below income.
 */
const MONTH = '2026-06';
const ROWS: readonly { label: string; amount: number; category: string }[] = [
	{ label: 'LANDLORD', amount: -850, category: 'Rent' },
	{ label: 'MARKET HALL', amount: -84.2, category: 'Groceries' },
	{ label: 'CORNER SHOP', amount: -61.1, category: 'Groceries' },
	{ label: 'CITY TRANSIT', amount: -42.5, category: 'Transport' },
	{ label: 'STREAMBOX', amount: -9.99, category: 'Streaming' },
	{ label: 'STREAMBOX', amount: -9.99, category: 'Streaming' },
	{ label: 'PHARMACY', amount: -18.9, category: 'Health' },
	{ label: 'EMPLOYER', amount: 2100, category: 'Salary' }
];
const BUDGETS: CategoryBudget[] = [
	{ category: 'Groceries', limitCents: 10_000 },
	{ category: 'Transport', limitCents: 5_000 },
	{ category: 'Health', limitCents: 10_000 }
] as CategoryBudget[];

function periodData(
	options: {
		incomeCents?: number;
		previousExpenseCents?: number;
		categories?: string[];
		/** As `readDashboardPeriodData` does: budgets reach the summary on a whole-month period only. */
		budgetsKnown?: boolean;
		/** Groceries at 850.00 too, tied with Rent. */
		tie?: boolean;
	} = {}
) {
	const rows = ROWS.filter(
		(row) =>
			row.category === 'Salary' || !options.categories || options.categories.includes(row.category)
	)
		.map((row) =>
			row.category === 'Salary' && options.incomeCents !== undefined
				? { ...row, amount: options.incomeCents / 100 }
				: row
		)
		.filter((row) => row.amount !== 0)
		.concat(options.tie ? [{ label: 'BULK STORE', amount: -704.7, category: 'Groceries' }] : []);
	const transactions: Transaction[] = rows.map((row, index) => {
		const amountCents = Math.round(row.amount * 100);
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
	const allocations = transactions.flatMap((transaction) =>
		allocationsOf({
			...transaction,
			nature: getEffectiveTransactionNature(transaction, new Map()).nature
		})
	);
	const budgetsKnown = options.budgetsKnown ?? true;
	const summary = summarizeMonthlyBudget(allocations, budgetsKnown ? BUDGETS : [], MONTH);
	const previousSummary = {
		...summarizeMonthlyBudget([], BUDGETS, '2026-05'),
		incomeCents: 210_000,
		expenseCents: options.previousExpenseCents ?? 100_000,
		balanceCents: 210_000 - (options.previousExpenseCents ?? 100_000)
	};
	return {
		transactions,
		allocations,
		budgets: BUDGETS,
		summary,
		previousSummary,
		budgetSummaryAvailable: budgetsKnown
	};
}

const ENV = {
	LLM_ENABLED: 'true',
	LLM_PROVIDER: 'ollama',
	LLM_BASE_URL: 'http://127.0.0.1:11434',
	LLM_MODEL: 'fake:996'
} as NodeJS.ProcessEnv;

/** Ollama's `/api/chat` answer, with `content` exactly as the model wrote it. */
function answering(content: unknown) {
	const chat = vi.fn(async (_init: RequestInit) => {
		const body = typeof content === 'string' ? content : JSON.stringify(content);
		return new Response(
			JSON.stringify({ message: { role: 'assistant', content: body }, done_reason: 'stop' }),
			{ status: 200 }
		);
	});
	vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: (input as Request).url;
		return url.endsWith('/api/version')
			? Promise.resolve(new Response(JSON.stringify({ version: '0.32.5' }), { status: 200 }))
			: chat((init ?? {}) as RequestInit);
	});
	return chat;
}

async function ask(content: unknown, options: Parameters<typeof periodData>[0] = {}) {
	const chat = answering(content);
	const prepared = prepareAdvice({
		periodData: periodData(options),
		includeLabels: false,
		env: ENV
	});
	const gateway = createGateway({
		admission: createAdmission({ queueDepth: 2, hourlyQuota: 20, now: () => 0 }),
		now: () => 0
	});
	const advice = await gateway.generateAdvice({
		userId: 'member',
		prepared,
		epoch: gateway.adviceEpoch('member'),
		signal: new AbortController().signal,
		env: ENV
	});
	return { advice, chat, prepared };
}

/** The top categories as the payload hands them to the model: the prompt's last line is the data. */
function payloadCategories(prompt: string): { alias: string; budgetStatus?: string }[] {
	return JSON.parse(prompt.split('\n').at(-1)!).topCategories;
}

const picks = (...list: [kind: string, category: string][]) => ({
	picks: list.map(([kind, category]) => ({ kind, category }))
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('#996: the model picks, the app writes', () => {
	// Each kind once where its fact holds. The whole advice is compared, so a field the model could
	// fill (a title, a message, a severity of its own) cannot ride along unseen.
	it.each([
		['top_category', 'c1', [{ category: 'Rent', amountCents: 85_000 }]],
		['no_budget', 'c1', [{ category: 'Rent', amountCents: 85_000 }]],
		['over_budget', 'c2', [{ category: 'Groceries', amountCents: 14_530 }]],
		['near_limit', 'c3', [{ category: 'Transport', amountCents: 4_250 }]],
		['recurring', 'c4', [{ category: 'Streaming', amountCents: 1_998 }]],
		['spending_up', 'all', []],
		['spent_less_than_earned', 'all', []]
	])('shows %s on %s, with the app’s figures', async (kind, alias, figures) => {
		const { advice } = await ask(picks([kind, alias]));
		expect(advice).toEqual({
			statements: [{ id: `${kind}-${alias}`, kind, figures }],
			unavailable: false
		});
	});

	it('shows spent_more_than_earned where the month spent more than its income', async () => {
		const { advice } = await ask(picks(['spent_more_than_earned', 'all']), { incomeCents: 50_000 });
		expect(advice).toEqual({
			statements: [
				{ id: 'spent_more_than_earned-all', kind: 'spent_more_than_earned', figures: [] }
			],
			unavailable: false
		});
	});

	it('holds top_category for each of two categories tied at the top', async () => {
		const { advice } = await ask(picks(['top_category', 'c1'], ['top_category', 'c2']), {
			tie: true
		});
		expect(advice.statements?.map((statement) => statement.id)).toEqual([
			'top_category-c1',
			'top_category-c2'
		]);
	});

	// Contradiction pass F1 (rev 1): budgets reach the summary only on a whole-month period, so on
	// « last 30 days » every category has a null status. « No budget » would then be false for
	// Groceries, which has one; the budget kinds hold only where budgets are known.
	it.each([
		['no_budget', 'c1'],
		['over_budget', 'c2'],
		['near_limit', 'c3']
	])('drops %s on %s when the period does not know its budgets', async (kind, alias) => {
		const { advice, prepared } = await ask(picks([kind, alias], ['top_category', 'c1']), {
			budgetsKnown: false
		});
		expect(payloadCategories(prepared.prompt).map((category) => category.budgetStatus)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined
		]);
		expect(advice.statements?.map((statement) => statement.id)).toEqual(['top_category-c1']);
	});

	it('drops spending_up when the previous month spent nothing', async () => {
		const { advice } = await ask(picks(['spending_up', 'all'], ['top_category', 'c1']), {
			previousExpenseCents: 0
		});
		expect(advice.statements?.map((statement) => statement.id)).toEqual(['top_category-c1']);
	});

	it('drops both income kinds when the period has no income', async () => {
		const { advice } = await ask(
			picks(
				['spent_more_than_earned', 'all'],
				['spent_less_than_earned', 'all'],
				['top_category', 'c1']
			),
			{ incomeCents: 0 }
		);
		expect(advice.statements?.map((statement) => statement.id)).toEqual(['top_category-c1']);
	});

	// The must-not-fire twin of every kind: the fact is false for that alias, so the pick goes. A
	// true sibling stays, so a missing pick was DROPPED, not the whole answer refused.
	it.each([
		['top_category', 'c2'],
		['no_budget', 'c2'],
		['over_budget', 'c3'],
		['near_limit', 'c2'],
		['recurring', 'c1'],
		['spent_more_than_earned', 'all']
	])('drops %s on %s, where the fact is false', async (kind, alias) => {
		const { advice } = await ask(picks([kind, alias], ['over_budget', 'c2']));
		expect(advice.statements?.map((statement) => statement.id)).toEqual(['over_budget-c2']);
	});

	it('drops spending_up when spending went down, and spent_less_than_earned when spending exceeded income', async () => {
		const { advice } = await ask(
			picks(['spending_up', 'all'], ['spent_less_than_earned', 'all'], ['over_budget', 'c2']),
			{ incomeCents: 50_000, previousExpenseCents: 200_000 }
		);
		expect(advice.statements?.map((statement) => statement.id)).toEqual(['over_budget-c2']);
	});

	it.each([
		['a category kind on the period', 'over_budget', 'all'],
		['a period kind on a category', 'spending_up', 'c1']
	])('drops %s', async (_name, kind, alias) => {
		const { advice } = await ask(picks([kind, alias], ['over_budget', 'c2']));
		expect(advice.statements?.map((statement) => statement.id)).toEqual(['over_budget-c2']);
	});

	it('drops an alias the payload has no category for: c4 when only three categories were spent in', async () => {
		const { advice, prepared } = await ask(picks(['no_budget', 'c4'], ['over_budget', 'c2']), {
			categories: ['Rent', 'Groceries', 'Transport']
		});
		expect(prepared.prompt, 'the payload has three categories').toContain('"alias":"c3"');
		expect(prepared.prompt).not.toContain('"alias":"c4"');
		expect(advice.statements?.map((statement) => statement.id)).toEqual(['over_budget-c2']);
	});

	it('keeps the model’s order and one of each pick', async () => {
		const { advice } = await ask(
			picks(['spending_up', 'all'], ['over_budget', 'c2'], ['spending_up', 'all'])
		);
		expect(advice.statements?.map((statement) => statement.id)).toEqual([
			'spending_up-all',
			'over_budget-c2'
		]);
	});

	it('withholds the answer when every pick is dropped', async () => {
		const { advice } = await ask(picks(['over_budget', 'c1'], ['near_limit', 'c2']));
		expect(advice).toEqual({
			statements: [],
			unavailable: true,
			failureCode: 'response_withheld'
		});
	});
});

describe('#996: no string the model writes can reach the card', () => {
	// The literature pass of 2026-10-11 (#998, #996): each of these reached the card through G3's
	// filters. Under #996 none has a field to travel in, so each is an unreadable answer.
	const ATTACKS = [
		't w e n t y',
		'twen-ty',
		'nlnety',
		'a score of outings',
		'Consider b/uying an E/TF.',
		'A tracker is a good home for your surplus.',
		`over_budget${String.fromCodePoint(0x202e)}`,
		`c${String.fromCodePoint(0xff12)}`,
		'C2',
		'c6',
		'c2 ',
		'c02'
	];

	it.each(ATTACKS)(
		'refuses %j as a kind and as a category, and repeats none of it',
		async (attack) => {
			for (const pick of [
				{ kind: attack, category: 'c2' },
				{ kind: 'over_budget', category: attack }
			]) {
				const { advice } = await ask({ picks: [pick, { kind: 'over_budget', category: 'c2' }] });
				expect(advice).toEqual({
					statements: [],
					unavailable: true,
					failureCode: 'response_unusable'
				});
				expect(JSON.stringify(advice)).not.toContain(attack);
			}
		}
	);

	it('refuses an answer carrying any field besides the picks: the old title and message included', async () => {
		const { advice } = await ask({
			summary: 'Your month',
			picks: [{ kind: 'over_budget', category: 'c2' }]
		});
		expect(advice.failureCode).toBe('response_unusable');
		const { advice: withText } = await ask({
			picks: [{ kind: 'over_budget', category: 'c2', title: 'Buy an ETF', message: 'now' }]
		});
		expect(withText.failureCode).toBe('response_unusable');
	});

	it('hands Ollama one grammar for every member: kinds and aliases are closed, nothing is free text', async () => {
		const { chat } = await ask(picks(['over_budget', 'c2']));
		const { format } = JSON.parse(String(chat.mock.calls[0][0].body)) as { format: unknown };
		const strings: unknown[] = [];
		const walk = (node: unknown): void => {
			if (node === null || typeof node !== 'object') return;
			const record = node as Record<string, unknown>;
			if (record.type === 'string') strings.push(record);
			Object.values(record).forEach(walk);
		};
		walk(format);
		expect(strings.length, 'the schema has string fields').toBe(2);
		for (const field of strings) expect(field).toHaveProperty('enum');
		const { chat: other } = await ask(picks(['spending_up', 'all']), { incomeCents: 50_000 });
		expect(JSON.parse(String(other.mock.calls[0][0].body)).format).toEqual(format);
	});

	it('names each category to the model by its alias, in payload order, with its budget status', async () => {
		const { prepared } = await ask(picks(['over_budget', 'c2']));
		expect(payloadCategories(prepared.prompt).map((category) => category.budgetStatus)).toEqual([
			'none',
			'over_budget',
			'near_limit',
			'none',
			'ok'
		]);
		for (const [alias, name] of [
			['c1', 'Rent'],
			['c2', 'Groceries'],
			['c3', 'Transport'],
			['c4', 'Streaming'],
			['c5', 'Health']
		]) {
			expect(prepared.prompt).toContain(`"alias":"${alias}","category":"${name}"`);
		}
	});
});
