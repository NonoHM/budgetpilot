import { createHash } from 'node:crypto';
import { getLocale } from '$lib/paraglide/runtime';
import type { DashboardPeriodData } from '$lib/server/dashboard/periodData';
import { readIntegerSetting } from '$lib/server/env/readSetting';
import {
	localLlmModel,
	probeLocalLlm,
	requestLocalBudgetInsights
} from '$lib/server/insights/local-llm';
import { buildBudgetInsightsPrompt } from '$lib/server/insights/prompt';
import { buildTransactionSummary } from '$lib/server/insights/summary';
import type { LocalAiAdvice, LocalLlmResult } from '$lib/server/insights/types';
import { createAdmission, type Admission } from './admission';

/**
 * THE ONE DOOR TO THE MODEL (#535). Nothing else imports the model call: ESLint refuses a static
 * or dynamic import of it, and of any entry point of the `ollama` client, anywhere under `src/lib`
 * and `src/routes` but here and in `insights/local-llm.ts`, and refuses an `import()` whose source
 * it cannot read. It does not see a raw `fetch` to Ollama's address; the transport work (G4, #967)
 * adds the check that `/api/chat` is spelled in one file.
 *
 * The order is the design and is not an optimisation: probe → cache → admission → generation.
 * - The probe comes BEFORE the cache, so a stopped model service stops cached advice too (spec F5).
 *   It asks whether the service answers, not whether the model is still installed.
 * - The cache comes BEFORE admission, so a reload of unchanged data neither waits nor is charged.
 * - Admission comes before the generation, so nothing past the room or the quota reaches the GPU.
 *
 * The AI switches (the instance's and the member's) are read by the caller on every request, because
 * the caller is also where the member's epoch is read, and the epoch must be read FIRST.
 */

/** A prompt and the key of the advice it would produce. */
export interface PreparedAdvice {
	key: string;
	prompt: string;
}

/**
 * The prompt is a pure function of what the model would receive, and it already carries the locale's
 * response language, the labels choice and the system text, so the key is the model and the prompt
 * and nothing else: a change to any of them is a change to the prompt. G2 adds a random marker to
 * the prompt, and the key then moves to the payload before the marker (spec F4).
 *
 * The MODEL NAME, not its digest: a re-pull of the same tag serves the old model's answer for up to
 * an hour. The digest arrives with the transport work (G4, #967).
 */
export function prepareAdvice(input: {
	periodData: DashboardPeriodData;
	includeLabels: boolean;
	env?: NodeJS.ProcessEnv;
	locale?: string;
}): PreparedAdvice {
	const { periodData, includeLabels } = input;
	const summary = buildTransactionSummary(
		periodData.transactions,
		periodData.allocations,
		periodData.summary,
		periodData.previousSummary,
		{ includeLabels }
	);
	const prompt = buildBudgetInsightsPrompt(summary, {
		includeLabels,
		locale: input.locale ?? getLocale()
	});
	const key = createHash('sha256')
		.update(JSON.stringify([localLlmModel(input.env ?? process.env), prompt]))
		.digest('hex');
	return { key, prompt };
}

/**
 * Twelve answers per member, an hour each. Twelve because a member flipping between months must get
 * a period they already saw back for free (the owner's usability ruling, 2026-10-10: one entry per
 * member regenerated, and charged, every month revisited), and twelve months is a year of them. An
 * hour because it is longer than a dashboard visit, and the key changes with the data anyway.
 * Constants with their reason rather than settings, because no operator needs to move them (spec
 * section 3). The bound in memory is 256 × 12 answers of a few kilobytes each.
 */
const CACHE_TTL_MS = 3_600_000;
const CACHE_ENTRIES_PER_MEMBER = 12;
const CACHE_MAX_MEMBERS = 256;
const MINUTE_MS = 60_000;

/**
 * A request nobody is waiting for any more: a newer one replaced it, or the member opted out. Marked,
 * so the card returns to its idle face and asks again on the next open, rather than reading it as a
 * model that had nothing to say (final pass F3).
 */
const CANCELLED: LocalAiAdvice = { insights: [], unavailable: false, cancelled: true };

function toAdvice(result: LocalLlmResult): LocalAiAdvice {
	return {
		insights: result.insights.filter((item) => item.source === 'local-llm'),
		unavailable: result.unavailable === true,
		...(result.failureCode ? { failureCode: result.failureCode } : {})
	};
}

export function createGateway(dependencies: { admission: Admission; now: () => number }) {
	const { admission, now } = dependencies;
	// Map order is insertion order, so re-inserting on every use makes the first key the least
	// recently used one, at both levels: members, and each member's answers.
	const cache = new Map<string, Map<string, { advice: LocalAiAdvice; at: number }>>();

	function touch<K, V>(map: Map<K, V>, key: K, value: V, bound: number): void {
		map.delete(key);
		map.set(key, value);
		while (map.size > bound) map.delete(map.keys().next().value!);
	}

	function cached(userId: string, key: string): LocalAiAdvice | undefined {
		const answers = cache.get(userId);
		const entry = answers?.get(key);
		if (!answers || !entry) return undefined;
		if (now() - entry.at >= CACHE_TTL_MS) {
			answers.delete(key);
			return undefined;
		}
		touch(answers, key, entry, CACHE_ENTRIES_PER_MEMBER);
		touch(cache, userId, answers, CACHE_MAX_MEMBERS);
		return entry.advice;
	}

	function remember(userId: string, key: string, advice: LocalAiAdvice): void {
		const answers = cache.get(userId) ?? new Map();
		touch(answers, key, { advice, at: now() }, CACHE_ENTRIES_PER_MEMBER);
		touch(cache, userId, answers, CACHE_MAX_MEMBERS);
	}

	return {
		adviceEpoch: (userId: string) => admission.epoch(userId),

		/** The member turned the AI or its labels off, or their account is gone. */
		forgetAdvice(userId: string): void {
			cache.delete(userId);
			admission.cancelUser(userId);
		},

		async generateAdvice(input: {
			userId: string;
			prepared: PreparedAdvice;
			epoch: number;
			signal: AbortSignal;
			env?: NodeJS.ProcessEnv;
		}): Promise<LocalAiAdvice> {
			const env = input.env ?? process.env;
			const refused = await probeLocalLlm(env);
			if (refused) return toAdvice(refused);

			const hit = cached(input.userId, input.prepared.key);
			if (hit) return hit;

			const ticket = await admission.acquire(input.userId, input.signal, input.epoch);
			if (ticket === 'cancelled') return CANCELLED;
			if (ticket === 'busy') return { insights: [], unavailable: true, failureCode: 'busy' };
			if (ticket === 'quota_reached') {
				// What the server knows and the reader cannot see: the minute the limit lifts. Rounded up,
				// so the sentence never says « 0 minutes » while a request would still be refused.
				const liftsAt = admission.quotaLiftsAt(input.userId) ?? now();
				const retryInMinutes = Math.max(1, Math.ceil((liftsAt - now()) / MINUTE_MS));
				return { insights: [], unavailable: true, failureCode: 'quota_reached', retryInMinutes };
			}

			try {
				const result = await requestLocalBudgetInsights(input.prepared.prompt, env, ticket.signal);
				// BEFORE the result is read: an aborted fetch raises AbortError, which the model client
				// reports as `cold_start`, and nobody is waiting for a sentence about a request a newer
				// one replaced. Before the cache write too, so advice finished after an opt-out is not
				// kept.
				if (ticket.signal.aborted || !result) return CANCELLED;
				const advice = toAdvice(result);
				if (!advice.unavailable) remember(input.userId, input.prepared.key, advice);
				return advice;
			} finally {
				ticket.release();
			}
		}
	};
}

let instance: ReturnType<typeof createGateway> | undefined;

/** Created on first use, so the two settings are read once and after the boot checks refused them. */
function gateway(): ReturnType<typeof createGateway> {
	instance ??= createGateway({
		admission: createAdmission({
			queueDepth: readIntegerSetting('BP_LLM_QUEUE_DEPTH'),
			hourlyQuota: readIntegerSetting('BP_LLM_USER_HOURLY'),
			now: Date.now
		}),
		now: Date.now
	});
	return instance;
}

export const generateAdvice: ReturnType<typeof createGateway>['generateAdvice'] = (input) =>
	gateway().generateAdvice(input);
export const adviceEpoch = (userId: string): number => gateway().adviceEpoch(userId);
export const forgetAdvice = (userId: string): void => gateway().forgetAdvice(userId);
