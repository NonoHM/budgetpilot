import { afterEach, describe, expect, it, vi } from 'vitest';
import { summarizeMonthlyBudget } from '$lib/domain/budget';
import { allocationsOf } from '$lib/domain/allocation';
import type { Transaction } from '$lib/domain/transaction';
import type { LocalAiAdvice } from '$lib/server/insights/types';
import { getEffectiveTransactionNature } from '$lib/server/transactions/nature';
import {
	FIXTURES,
	OUTPUT_ITEMS,
	SIBLING,
	type FixtureId,
	type OutputItem,
	type SeedTransaction
} from './qualification/corpus';
import { createAdmission } from './admission';
import { createGateway, prepareAdvice } from './gateway';

/**
 * The output side (#996) at the model's own HTTP door: every ruling of the qualification corpus, run
 * in-process. `e2e/ai-qualification.spec.ts` runs the same rulings on the build against a scripted
 * model; this is the fast loop, and the two agree because both read `expect` from the corpus, which
 * no code computes.
 *
 * Nothing is faked but Ollama's HTTP answer, so the parse, the gateway and the acceptance are the
 * production ones (the harness of `statements.spec.ts`). The period is the fixture as the e2e suite
 * seeds it: one whole month, no budget, no previous month, so budgets are known and every category
 * has none.
 */
const ENV = {
	LLM_ENABLED: 'true',
	LLM_PROVIDER: 'ollama',
	LLM_BASE_URL: 'http://127.0.0.1:11434',
	LLM_MODEL: 'fake:996'
} as NodeJS.ProcessEnv;
const MONTH = '2026-06';

function periodData(rows: readonly SeedTransaction[]) {
	const transactions: Transaction[] = rows.map((row, index) => {
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
	const allocations = transactions.flatMap((transaction) =>
		allocationsOf({
			...transaction,
			nature: getEffectiveTransactionNature(transaction, new Map()).nature
		})
	);
	return {
		transactions,
		allocations,
		budgets: [],
		summary: summarizeMonthlyBudget(allocations, [], MONTH),
		previousSummary: undefined,
		budgetSummaryAvailable: true
	};
}

/** Ollama's `/api/chat` answer, with `content` exactly as the model wrote it. */
function answering(content: unknown) {
	const chat = vi.fn(async () => {
		const body = typeof content === 'string' ? content : JSON.stringify(content);
		return new Response(
			JSON.stringify({ message: { role: 'assistant', content: body }, done_reason: 'stop' }),
			{ status: 200 }
		);
	});
	vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: (input as Request).url;
		return url.endsWith('/api/version')
			? Promise.resolve(new Response(JSON.stringify({ version: '0.32.5' }), { status: 200 }))
			: chat();
	});
	return chat;
}

function prepare(fixture: FixtureId) {
	const definition = FIXTURES[fixture];
	return prepareAdvice({
		periodData: periodData(definition.transactions),
		includeLabels: 'includeLabels' in definition && definition.includeLabels,
		env: ENV
	});
}

function newGateway() {
	return createGateway({
		admission: createAdmission({ queueDepth: 2, hourlyQuota: 20, now: () => 0 }),
		now: () => 0
	});
}

async function generate(
	gateway: ReturnType<typeof newGateway>,
	prepared: ReturnType<typeof prepare>
) {
	return gateway.generateAdvice({
		userId: 'member',
		prepared,
		epoch: gateway.adviceEpoch('member'),
		signal: new AbortController().signal,
		env: ENV
	});
}

/**
 * The figure the card must show beside an alias, from the fixture's own rows: `cN` is the N-th
 * largest spending category and its total, `all` has none. Arithmetic on the corpus literal, not a
 * call into the report code that ranks the payload, so a payload that named the wrong category under
 * an alias is a difference here.
 */
function figuresOf(fixture: FixtureId, alias: string): { category: string; amountCents: number }[] {
	if (alias === 'all') return [];
	const totals = new Map<string, number>();
	for (const row of FIXTURES[fixture].transactions) {
		const cents = Math.round(Number(row.amount) * 100);
		if (cents < 0) totals.set(row.category, (totals.get(row.category) ?? 0) - cents);
	}
	const ranked = [...totals].sort((left, right) => right[1] - left[1]);
	const [category, amountCents] = ranked[Number(alias.slice(1)) - 1];
	return [{ category, amountCents }];
}

/** The whole advice the gateway must answer for an item: its `expect`, spelled as the card reads it. */
function adviceOf(item: OutputItem): LocalAiAdvice {
	if ('failureCode' in item.expect) {
		return { statements: [], unavailable: true, failureCode: item.expect.failureCode };
	}
	return {
		statements: item.expect.statements.map((id) => {
			const at = id.lastIndexOf('-');
			return {
				id,
				kind: id.slice(0, at),
				figures: figuresOf(item.fixture, id.slice(at + 1))
			} as LocalAiAdvice['statements'][number];
		}),
		unavailable: false
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('the corpus output rulings, at the gateway (#996)', () => {
	it('reads the figures of month-en as the corpus describes them (the calibration of the oracle)', () => {
		expect(['c1', 'c2', 'c3', 'c4', 'c5'].map((alias) => figuresOf('month-en', alias))).toEqual([
			[{ category: 'Rent', amountCents: 85_000 }],
			[{ category: 'Groceries', amountCents: 14_530 }],
			[{ category: 'Transport', amountCents: 4_250 }],
			[{ category: 'Insurance', amountCents: 3_500 }],
			[{ category: 'Health', amountCents: 1_890 }]
		]);
	});

	// The whole advice is compared, so a field the model could fill cannot ride along unseen, and a
	// refused answer carries none of the text that made it refused.
	it.each(OUTPUT_ITEMS.map((item) => [item.id, item] as const))('%s', async (_id, item) => {
		const chat = answering(item.answer);
		const advice = await generate(newGateway(), prepare(item.fixture));
		expect(chat, 'this item reached the model exactly once').toHaveBeenCalledTimes(1);
		expect(advice).toEqual(adviceOf(item));
	});
});

describe('the order at the gateway (#996)', () => {
	// Accepted before the cache write, versus a cache hit serving a pick the app dropped.
	it('serves from the cache only what it accepted', async () => {
		const chat = answering({
			picks: [{ kind: 'over_budget', category: 'c2' }, SIBLING.pick]
		});
		const gateway = newGateway();
		const prepared = prepare('month-en');
		const first = await generate(gateway, prepared);
		const second = await generate(gateway, prepared);
		expect(chat, 'one generation').toHaveBeenCalledTimes(1);
		expect(first.statements.map((statement) => statement.id)).toEqual([SIBLING.id]);
		expect(second, 'the cache hit').toEqual(first);
	});
});
