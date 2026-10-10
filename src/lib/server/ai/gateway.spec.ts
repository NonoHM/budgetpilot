import { beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeMonthlyBudget } from '$lib/domain/budget';
import { allocationsOf } from '$lib/domain/allocation';
import type { Transaction } from '$lib/domain/transaction';
import type { LocalLlmResult } from '$lib/server/insights/types';
import { getEffectiveTransactionNature } from '$lib/server/transactions/nature';
import { createAdmission } from './admission';

/**
 * The gateway's order and its two stores (#535): switches, probe, cache, admission, generation. The
 * model call and the probe are faked so their call counts are the measure; admission and the cache
 * are real, so a quota or an entry is observed rather than asserted on a double.
 */
const llm = vi.hoisted(() => ({
	probeLocalLlm: vi.fn<() => Promise<LocalLlmResult | null>>(async () => null),
	requestLocalBudgetInsights:
		vi.fn<
			(
				prompt: string,
				env: NodeJS.ProcessEnv,
				signal: AbortSignal
			) => Promise<LocalLlmResult | null>
		>()
}));
vi.mock('$lib/server/insights/local-llm', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/insights/local-llm')>()),
	...llm
}));

const { createGateway, prepareAdvice } = await import('./gateway');

const ENV = { LLM_ENABLED: 'true', LLM_MODEL: 'qwen2.5:0.5b' } as NodeJS.ProcessEnv;
const ACCEPTED: LocalLlmResult = {
	summary: 's',
	insights: [
		{
			id: 'local-llm-1',
			title: 'T',
			message: 'M',
			severity: 'info',
			category: 'spending',
			source: 'local-llm'
		}
	]
};
const ADVICE = { insights: ACCEPTED.insights, unavailable: false };
/** A request nobody is waiting for: the card returns to its idle face and may ask again. */
const NOTHING = { insights: [], unavailable: false, cancelled: true };

const transactions: Transaction[] = [
	{
		id: 'rent',
		date: '2026-06-02',
		label: 'CARTE AUCHAN PARIS 23/06',
		amountCents: -120_000,
		type: 'expense',
		category: 'Logement',
		source: 'csv'
	}
];
function periodData(fixture: Transaction[] = transactions) {
	const allocations = fixture.flatMap((transaction) =>
		allocationsOf({
			...transaction,
			nature: getEffectiveTransactionNature(transaction, new Map()).nature
		})
	);
	return {
		transactions: fixture,
		allocations,
		budgets: [],
		summary: summarizeMonthlyBudget(allocations, [], '2026-06'),
		previousSummary: undefined,
		budgetSummaryAvailable: true
	};
}
const prepared = (includeLabels = false, env = ENV) =>
	prepareAdvice({ periodData: periodData(), includeLabels, env, locale: 'en' });

function fresh(options: { queueDepth?: number; hourlyQuota?: number } = {}) {
	const admission = createAdmission({
		queueDepth: options.queueDepth ?? 2,
		hourlyQuota: options.hourlyQuota ?? 20,
		now: () => 0
	});
	return { admission, gateway: createGateway({ admission, now: () => 0 }) };
}
const open = () => new AbortController().signal;

describe('prepareAdvice (#535)', () => {
	// The key follows exactly what the model would receive, versus a key that misses a change and
	// serves advice about other data.
	it('gives the same key for the same input, and another when data, labels, locale or model change', () => {
		const base = prepared().key;
		expect(prepared().key).toBe(base);
		expect(prepared(true).key).not.toBe(base);
		expect(prepared(false, { ...ENV, LLM_MODEL: 'other:1b' }).key).not.toBe(base);
		expect(
			prepareAdvice({ periodData: periodData(), includeLabels: false, env: ENV, locale: 'fr' }).key
		).not.toBe(base);
		const moreData = periodData([...transactions, { ...transactions[0], id: 'second' }]);
		expect(
			prepareAdvice({ periodData: moreData, includeLabels: false, env: ENV, locale: 'en' }).key
		).not.toBe(base);
	});

	// The key is a digest, versus the prompt (and the labels in it) shipped to the page as a key.
	it('is a sha256 digest that carries no text of the prompt', () => {
		const { key, prompt } = prepared(true);
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(prompt).toContain('Auchan');
	});
});

describe('generateAdvice (#535)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		llm.probeLocalLlm.mockResolvedValue(null);
		llm.requestLocalBudgetInsights.mockResolvedValue(ACCEPTED);
	});

	function ask(
		gateway: ReturnType<typeof fresh>['gateway'],
		userId = 'u1',
		signal = open(),
		advice = prepared()
	) {
		return gateway.generateAdvice({
			userId,
			prepared: advice,
			epoch: gateway.adviceEpoch(userId),
			signal,
			env: ENV
		});
	}

	it('generates once and answers the accepted advice', async () => {
		const { gateway } = fresh();
		expect(await ask(gateway)).toEqual(ADVICE);
		expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(1);
	});

	// Spec F5: a stopped model stops cached output too, versus the cache outliving the kill switch.
	it('a failed probe answers its failure and the cache is not read', async () => {
		const { gateway } = fresh();
		await ask(gateway);
		llm.probeLocalLlm.mockResolvedValueOnce({
			summary: '',
			insights: [],
			unavailable: true,
			failureCode: 'unreachable'
		});
		expect(await ask(gateway)).toEqual({
			insights: [],
			unavailable: true,
			failureCode: 'unreachable'
		});
		expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(1);
	});

	// A cache hit used no GPU, versus a reload that eats the hourly quota for the same answer.
	it('a cache hit generates nothing and is not charged to the quota', async () => {
		const { gateway } = fresh({ hourlyQuota: 1 });
		await ask(gateway);
		expect(await ask(gateway)).toEqual(ADVICE);
		expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(1);
	});

	// The owner's usability ruling (2026-10-10): flipping back to a period already seen is free,
	// versus one entry per member regenerating, and charging, every month revisited.
	it('serves a period revisited after another one from the cache, without charging it', async () => {
		const { gateway } = fresh({ hourlyQuota: 2 });
		const june = prepared(false);
		const juneWithLabels = prepared(true);
		await ask(gateway, 'u1', open(), june);
		await ask(gateway, 'u1', open(), juneWithLabels);
		expect(await ask(gateway, 'u1', open(), june)).toEqual(ADVICE);
		expect(await ask(gateway, 'u1', open(), juneWithLabels)).toEqual(ADVICE);
		expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(2);
	});

	// The per-member bound is a count, versus a member's entries growing with every period viewed.
	it('keeps at most twelve answers per member, dropping the least recently used', async () => {
		const { gateway } = fresh({ hourlyQuota: 120 });
		const keys = Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, prompt: `p${i}` }));
		for (const advice of keys) await ask(gateway, 'u1', open(), advice);
		// k1 is the oldest of the twelve kept, so a hit; k0 was the thirteenth back, so a miss.
		await ask(gateway, 'u1', open(), keys[1]);
		expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(13);
		await ask(gateway, 'u1', open(), keys[0]);
		expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(14);
	});

	// The refusal says when it lifts, rounded UP to the minute, versus « in 0 minutes ».
	it('a quota refusal carries the minutes until it lifts, rounded up', async () => {
		let t = 0;
		const admission = createAdmission({ queueDepth: 2, hourlyQuota: 1, now: () => t });
		const gateway = createGateway({ admission, now: () => t });
		await ask(gateway, 'u1', open(), prepared(true));
		t = 3_600_000 - 61_000;
		expect(await ask(gateway)).toEqual({
			insights: [],
			unavailable: true,
			failureCode: 'quota_reached',
			retryInMinutes: 2
		});
	});

	// One entry per member, versus a second member served the first member's entry.
	it('never serves one member the entry of another', async () => {
		const { gateway } = fresh();
		await ask(gateway, 'u1');
		await ask(gateway, 'u2');
		expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(2);
	});

	// Only an accepted answer is kept, versus a cold start served from the cache for an hour.
	it('does not cache an unavailable answer', async () => {
		const { gateway } = fresh();
		llm.requestLocalBudgetInsights.mockResolvedValueOnce({
			summary: '',
			insights: [],
			unavailable: true,
			failureCode: 'cold_start'
		});
		await ask(gateway);
		expect(await ask(gateway)).toEqual(ADVICE);
		expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(2);
	});

	it('answers a busy refusal as unavailable with that code', async () => {
		const { gateway, admission } = fresh({ queueDepth: 0 });
		await admission.acquire('other', open(), admission.epoch('other'));
		expect(await ask(gateway)).toEqual({ insights: [], unavailable: true, failureCode: 'busy' });
	});

	// Rev 1 F3: an aborted fetch raises AbortError, which the model client reads as `cold_start`.
	// A superseded generation must render nothing, versus « the model is loading » over a request
	// nobody is waiting for. And it is not cached.
	it('a generation superseded mid-flight answers nothing and caches nothing', async () => {
		const { gateway, admission } = fresh();
		let finish!: (value: LocalLlmResult) => void;
		llm.requestLocalBudgetInsights.mockImplementationOnce(
			() => new Promise((resolve) => (finish = resolve))
		);
		const june = prepared(false);
		const older = ask(gateway, 'u1', open(), june);
		await vi.waitFor(() => expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(1));
		const newer = ask(gateway, 'u1', open(), prepared(true));
		// The newer request has superseded the older one only once it is in the room.
		await vi.waitFor(() => expect(admission.waiting).toBe(1));
		// An ACCEPTED answer arriving after the supersession: the case where caching it would show.
		finish(ACCEPTED);
		expect(await older).toEqual(NOTHING);
		expect(await newer).toEqual(ADVICE);
		await ask(gateway, 'u1', open(), june);
		expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(3);
	});

	// Final pass F6: the hour is a bound, versus an answer served forever.
	it('serves an answer for an hour and generates again once the hour is over', async () => {
		let t = 0;
		const admission = createAdmission({ queueDepth: 2, hourlyQuota: 20, now: () => t });
		const gateway = createGateway({ admission, now: () => t });
		await ask(gateway);
		t = 3_600_000 - 1;
		await ask(gateway);
		expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(1);
		t = 3_600_000;
		await ask(gateway);
		expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(2);
	});

	// Final pass F6: 256 members are kept, versus a cache that grows with every account.
	it('keeps the answers of 256 members, dropping the least recently used', async () => {
		const { gateway } = fresh();
		for (let member = 0; member < 257; member++) await ask(gateway, `m${member}`);
		expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(257);
		await ask(gateway, 'm1');
		expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(257);
		await ask(gateway, 'm0');
		expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(258);
	});

	// The slot is freed whatever the generation does, versus one throw locking the model for good.
	it('releases the slot when the generation throws', async () => {
		const { gateway, admission } = fresh({ queueDepth: 0 });
		llm.requestLocalBudgetInsights.mockRejectedValueOnce(new Error('boom'));
		await expect(ask(gateway)).rejects.toThrow('boom');
		expect(admission.inFlight).toBe(0);
	});

	// The opt-out reaches both stores, versus advice derived from labels kept after consent ended.
	it('forgetAdvice drops the member entry and aborts their running generation', async () => {
		const { gateway } = fresh();
		await ask(gateway);
		gateway.forgetAdvice('u1');
		let seen!: AbortSignal;
		let finish!: (value: LocalLlmResult) => void;
		llm.requestLocalBudgetInsights.mockImplementationOnce((_prompt, _env, signal) => {
			seen = signal;
			return new Promise((resolve) => (finish = resolve));
		});
		const running = ask(gateway);
		await vi.waitFor(() => expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(2));
		gateway.forgetAdvice('u1');
		expect(seen.aborted).toBe(true);
		finish(ACCEPTED);
		expect(await running).toEqual(NOTHING);
		// Not cached after the opt-out either: the next ask generates again.
		await ask(gateway);
		expect(llm.requestLocalBudgetInsights).toHaveBeenCalledTimes(3);
	});

	// Rev 1 F2: an epoch read before the opt-out starts nothing.
	it('a stale epoch answers nothing and starts no generation', async () => {
		const { gateway } = fresh();
		const epoch = gateway.adviceEpoch('u1');
		gateway.forgetAdvice('u1');
		expect(
			await gateway.generateAdvice({
				userId: 'u1',
				prepared: prepared(),
				epoch,
				signal: open(),
				env: ENV
			})
		).toEqual(NOTHING);
		expect(llm.requestLocalBudgetInsights).not.toHaveBeenCalled();
	});

	// The caller's signal reaches the model call, versus a closed tab still generating.
	it('the caller signal reaches the model call', async () => {
		const { gateway } = fresh();
		const outer = new AbortController();
		let seen!: AbortSignal;
		llm.requestLocalBudgetInsights.mockImplementationOnce(async (_prompt, _env, signal) => {
			seen = signal;
			return ACCEPTED;
		});
		await ask(gateway, 'u1', outer.signal);
		outer.abort();
		expect(seen.aborted).toBe(true);
	});

	// The prompt sent is the prepared one, versus a gateway rebuilding it from other inputs.
	it('sends the prepared prompt', async () => {
		const { gateway } = fresh();
		const advice = prepared(true);
		await ask(gateway, 'u1', open(), advice);
		expect(llm.requestLocalBudgetInsights.mock.calls[0][0]).toBe(advice.prompt);
	});
});
