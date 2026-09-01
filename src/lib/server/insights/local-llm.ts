import { Ollama } from 'ollama';
import { LOCAL_LLM_FALLBACK_CODE } from '$lib/domain/failureCodes';
import { failureCode, isTimeoutError } from '$lib/server/errors';
import { stripMarkdown } from './plainText';
import { parseHostsCsv } from '$lib/server/hosts';
import { fetchWithRedirectGuard } from '$lib/server/net/redirectGuard';
import { localLlmJsonSchema, localLlmNumPredict, localLlmResponseSchema } from './schema';
import type { BudgetInsight, LocalLlmFailureCode, LocalLlmResult } from './types';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5:0.5b';
/**
 * TWO BUDGETS, NOT ONE, and the split is the fix for #524 rather than a bigger number.
 *
 * One `AbortSignal.timeout` used to cover connect, model load and generation together, so the
 * single number had to be sized for the slowest of the three while being spent on the fastest. A
 * cold Ollama loads a model into VRAM before it emits anything, which took longer than the budget
 * the Docker overlay was handing us, and the abort killed the load that would have made the budget
 * sufficient. The screen then said « Assistant IA indisponible », which is the transient-sounding
 * sentence for the one state that would have resolved itself.
 *
 * Raising the single number fixes that case and makes EVERY real failure slower to report: a
 * genuinely stopped Ollama would cost the full generation budget before the card appeared. So the
 * connect leg gets its own budget, spent before any model work begins:
 *
 * - `LLM_CONNECT_TIMEOUT_MS` (2s) asks only whether something is listening and speaking HTTP. A
 *   stopped service is refused in about two seconds, which is FASTER than the ten it used to cost.
 * - `LLM_TIMEOUT_MS` (45s) then covers load and generation, and is spent only once the service has
 *   answered, which is exactly the path where waiting is the right answer.
 *
 * The measurement behind 45s is in #59, whose commit message reads "The 10s default timeout was
 * below what a cold Ollama needs just to load a model".
 */
export const LOCAL_LLM_ENV_DEFAULTS = {
	LLM_TIMEOUT_MS: 45_000,
	LLM_CONNECT_TIMEOUT_MS: 2_000
} as const;
const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
// host.docker.internal refers to the host machine itself from inside a Docker container:
// it isn't a remote server, so http: remains acceptable (Ollama doesn't serve TLS there).
const DEFAULT_HTTP_PERMITTED_HOSTS = [...DEFAULT_ALLOWED_HOSTS, 'host.docker.internal'];

export function isLocalLlmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.LLM_ENABLED === 'true' && (env.LLM_PROVIDER ?? 'ollama') === 'ollama';
}

/** One shape for every giving-up path, so a code can never be omitted where `unavailable` is set. */
function unavailable(code: LocalLlmFailureCode): LocalLlmResult {
	return { summary: '', insights: [], unavailable: true, failureCode: code };
}

/**
 * Ollama answered on `/api/version`, an endpoint that never touches a model, within the connect
 * budget. ANY HTTP status counts as reachable, deliberately: the question this leg answers is
 * whether a socket accepted us and spoke HTTP, not whether that particular path exists. Treating a
 * 404 here as unreachable would report a stopped service on an Ollama build that simply moved the
 * endpoint, which is the comfortable-direction failure AGENTS.md warns about.
 *
 * The redirect guard is the same one the generation call uses and holds the same allowlist, so this
 * extra request widens no SSRF surface: a 3xx to a non-allowlisted host throws here exactly as it
 * would there, before anything is sent to it.
 */
async function probeLocalLlmReachable(
	baseUrl: string,
	connectTimeoutMs: number,
	env: NodeJS.ProcessEnv
): Promise<boolean> {
	try {
		await fetchWithRedirectGuard(
			`${baseUrl}/api/version`,
			{ method: 'GET', signal: AbortSignal.timeout(connectTimeoutMs) },
			{ isRedirectTargetAllowed: (target) => getLocalBaseUrl(target.href, env) !== null }
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * The recogniser for this subsystem, in the sense `$lib/server/errors` defines: it maps a caught
 * error to a code the interface owns a sentence for, or null when it does not know.
 *
 * `cold_start` is sound HERE and would not be at the top of the function: the probe has already
 * answered by the time this runs, so a budget that expires afterwards means something IS listening
 * and is slow, which is a model load. The ordering is what makes the code true, so the probe is not
 * an optimisation that can be removed later without moving this.
 */
const recogniseLocalLlmFailure = (caught: unknown): LocalLlmFailureCode | null => {
	if (isTimeoutError(caught)) return 'cold_start';
	if (isModelNotFound(caught)) return 'model_unavailable';
	return null;
};

/**
 * Ollama's client throws `ResponseError` with a `status_code`, and 404 on `/api/chat` means the
 * model tag is not pulled. Matched structurally rather than with `instanceof`, because the class is
 * internal to the package and not exported from its entry point: importing it would couple us to a
 * path outside the public surface, and the shape is the stable part.
 */
function isModelNotFound(caught: unknown): boolean {
	if (typeof caught !== 'object' || caught === null) return false;
	const candidate = caught as { name?: unknown; status_code?: unknown };
	return candidate.name === 'ResponseError' && candidate.status_code === 404;
}

export async function requestLocalBudgetInsights(
	prompt: string,
	env: NodeJS.ProcessEnv = process.env
): Promise<LocalLlmResult | null> {
	if (!isLocalLlmEnabled(env)) return null;

	const baseUrl = getLocalBaseUrl(env.LLM_BASE_URL ?? DEFAULT_BASE_URL, env);
	// Refused by the host allowlist, before any socket is opened. Distinct from "nothing answered":
	// no amount of waiting fixes a base URL the allowlist will not accept.
	if (!baseUrl) return unavailable('not_configured');

	const model = env.LLM_MODEL ?? DEFAULT_MODEL;
	const timeoutMs = parsePositiveInt(env.LLM_TIMEOUT_MS, LOCAL_LLM_ENV_DEFAULTS.LLM_TIMEOUT_MS);
	const connectTimeoutMs = parsePositiveInt(
		env.LLM_CONNECT_TIMEOUT_MS,
		LOCAL_LLM_ENV_DEFAULTS.LLM_CONNECT_TIMEOUT_MS
	);

	if (!(await probeLocalLlmReachable(baseUrl, connectTimeoutMs, env))) {
		return unavailable('unreachable');
	}

	const client = new Ollama({
		host: baseUrl,
		// #215: guard redirects here too. The base URL is allowlisted (getLocalBaseUrl above), but a
		// redirect could still bounce the fetch to a non-allowlisted host; every redirect target is
		// re-validated against the same allowlist. Smaller exposure than the bank client (localhost
		// only), identical guard-scope gap.
		fetch: (input, init) =>
			fetchWithRedirectGuard(
				typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
				{ ...init, signal: AbortSignal.timeout(timeoutMs) },
				{ isRedirectTargetAllowed: (target) => getLocalBaseUrl(target.href, env) !== null }
			)
	});

	try {
		const response = await client.chat({
			model,
			messages: [{ role: 'user', content: prompt }],
			format: localLlmJsonSchema,
			// UNCONDITIONAL, and the absence of a capability gate is the decision rather than the
			// shortcut. A reasoning model spends its reasoning tokens out of the same `num_predict`
			// budget as the answer, so the ceiling below can be correctly sized for the schema and
			// still leave nothing for the JSON. Measured in #527 on qwen3.5:4b-q8_0 over a prompt built
			// from this module's own builders: without this field, `done_reason: length`, 1060 tokens
			// and ZERO characters of content; with it, `stop`, 282 tokens and complete French JSON.
			// So on a model that reasons this is not an optimisation, it is the only measured
			// configuration in which an answer arrives at all.
			//
			// Sent to every model because a model with no thinking capability accepts it and generates
			// normally, measured on qwen2.5:0.5b and ministral-3:3b: HTTP 200, no error field. A gate
			// is therefore available and buys nothing, at the cost of a request per generation and a
			// second thing to keep true. Where it would read from was checked against a running server
			// rather than against the client's types, because the two disagree: Ollama 0.32.5 returns
			// `capabilities` per model on `/api/tags`, carrying `thinking` for qwen3.5:4b-q8_0 and not
			// for qwen2.5:0.5b, while `ollama@0.6.3` declares that field only on `ShowResponse`. So the
			// endpoint sends something the typed client cannot see, and reading the `.d.ts` alone gives
			// the wrong answer about whether the gate is even buildable.
			//
			// It does NOT replace the ceiling. A model that ignores `think` reasons anyway, and no
			// model measured here ignores it, so that branch is untested rather than handled.
			think: false,
			options: {
				temperature: 0.2,
				// Derived from the schema, never a literal. 512 shipped with the initial release and was
				// never revisited while the schema was, and it sits below the schema's own worst case in
				// every estimate: a fully populated five-insight French response could not fit even with
				// no reasoning tokens at all. See `localLlmNumPredict` for the measurement.
				num_predict: localLlmNumPredict()
			}
		});

		// `done_reason` has always been on this response and nothing read it. It is the one field that
		// separates "the ceiling cut the answer off" from "the model produced something unreadable",
		// which are the same broken JSON string and opposite advice to the person reading the card.
		const truncated = response.done_reason === 'length';

		const content = response.message?.content;
		if (!content) return unreadable(truncated);

		return parseLocalLlmContent(content, truncated);
	} catch (caught) {
		// `unreachable` is the fallback rather than a catch-all sentence: the probe answered, so
		// anything unrecognised here is the connection having failed since, which is the honest
		// reading and the one whose advice ("check that it is running") stays true.
		return unavailable(failureCode(caught, recogniseLocalLlmFailure, LOCAL_LLM_FALLBACK_CODE));
	}
}

/**
 * The single place the truncated/unusable rule is expressed, so the three call sites cannot come to
 * disagree about which code an unreadable answer earns.
 *
 * THE RULE HAS TWO HALVES AND ONLY ONE OF THEM IS A FUNCTION, so both are stated here rather than
 * one here and one wherever it happens to be executed.
 *
 * 1. An answer that could NOT be read earns `response_truncated` when `done_reason` was `length`,
 *    and `response_unusable` otherwise. That is this function.
 * 2. An answer that COULD be read is KEPT, whatever stopped the generation. That is the accept path
 *    at the end of `parseLocalLlmContent`, and it is implemented as the ABSENCE of a branch, which
 *    is exactly why it is written down here: there is no line at that site for a reader to find.
 *
 * Half 2 is a decision and not an oversight. `done_reason` says how generation ENDED; the schema
 * says whether what arrived IS an answer, and those are different questions. Refusing a
 * schema-valid answer because of how it stopped would discard a good result to honour a symptom,
 * and would show the reader « le modèle a manqué de place … le conseil n'a pas pu être lu » over
 * advice that could be read perfectly well.
 *
 * Pinned by a test, because nothing checks a comment. The existing pair in `local-llm.spec.ts`
 * varies `done_reason` over the SAME broken content, so it separates the two CODES and is blind to
 * half 2 entirely; the third case, `length` over VALID content, is the only one that can see it.
 * Recorded at #531.
 */
function unreadable(truncated: boolean): LocalLlmResult {
	return unavailable(truncated ? 'response_truncated' : 'response_unusable');
}

function parseLocalLlmContent(content: string, truncated: boolean): LocalLlmResult {
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(content);
	} catch {
		// The reported shape: a 200 in 4.7 s whose JSON stops mid-object because the generation ran out
		// of tokens. Valid JSON up to the cut, and `JSON.parse` fails on the last character.
		return unreadable(truncated);
	}

	const parsed = localLlmResponseSchema.safeParse(parsedJson);
	if (!parsed.success) return unreadable(truncated);

	// Half 2 of the rule stated beside `unreadable`: a schema-valid answer is kept whatever stopped
	// the generation, so `truncated` is deliberately not read from here on.

	// Stripped at RECEPTION, after validation and before anything else sees the text. Neither the
	// schema nor the prompt forbids markdown, so a model that emits « **35%** » puts the asterisks on
	// screen, and which model the operator pulled decides whether that happens. Stripping here means
	// one place rather than one per render site, and it never turns generated text into markup.
	const insights: BudgetInsight[] = parsed.data.insights.map((item, index) => ({
		id: `local-llm-${index + 1}`,
		title: stripMarkdown(item.title),
		message: stripMarkdown(item.message),
		severity: item.severity,
		category: item.category,
		source: 'local-llm'
	}));

	return { summary: stripMarkdown(parsed.data.summary), insights };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getAllowedHosts(env: NodeJS.ProcessEnv): string[] {
	const hosts = parseHostsCsv(env.LLM_ALLOWED_HOSTS);
	return hosts.length > 0 ? hosts : DEFAULT_ALLOWED_HOSTS;
}

// Internal hosts (Docker Compose network, host aliases...) where Ollama doesn't serve TLS:
// http: remains acceptable there in addition to the localhost/127.0.0.1/::1/host.docker.internal baseline.
// Nothing hardcoded here beyond that baseline: any additional host goes through the env var.
function getHttpPermittedHosts(env: NodeJS.ProcessEnv): string[] {
	return [...DEFAULT_HTTP_PERMITTED_HOSTS, ...parseHostsCsv(env.LLM_HTTP_PERMITTED_HOSTS)];
}

function getLocalBaseUrl(value: string, env: NodeJS.ProcessEnv): string | null {
	try {
		const url = new URL(value);
		const allowedHosts = getAllowedHosts(env);
		const isAllowedHost = allowedHosts.includes(url.hostname);
		if (!isAllowedHost) return null;

		const isHttpPermitted = getHttpPermittedHosts(env).includes(url.hostname);
		const hasValidProtocol = isHttpPermitted ? url.protocol === 'http:' : url.protocol === 'https:';
		if (!hasValidProtocol) return null;
		url.pathname = url.pathname.replace(/\/+$/, '');
		url.search = '';
		url.hash = '';
		return url.toString().replace(/\/+$/, '');
	} catch {
		return null;
	}
}
