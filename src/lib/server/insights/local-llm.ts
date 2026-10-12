import { Ollama } from 'ollama';
import { z, type ZodType } from 'zod';
import { LOCAL_LLM_FALLBACK_CODE } from '$lib/domain/failureCodes';
import { failureCode, isTimeoutError } from '$lib/server/errors';
import { parseHostsCsv } from '$lib/server/hosts';
import { fetchWithRedirectGuard } from '$lib/server/net/redirectGuard';
import { readIntegerSetting } from '$lib/server/env/readSetting';
import { SETTINGS } from '$lib/server/env/settings';
import { OperatorFacingError } from '$lib/server/operatorFacingError';
import type { LocalLlmFailureCode, LocalLlmResult, ModelIdentity } from './types';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
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
	LLM_TIMEOUT_MS: SETTINGS.LLM_TIMEOUT_MS.default,
	LLM_CONNECT_TIMEOUT_MS: SETTINGS.LLM_CONNECT_TIMEOUT_MS.default
} as const;
const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
// host.docker.internal refers to the host machine itself from inside a Docker container:
// it isn't a remote server, so http: remains acceptable (Ollama doesn't serve TLS there).
const DEFAULT_HTTP_PERMITTED_HOSTS = [...DEFAULT_ALLOWED_HOSTS, 'host.docker.internal'];

/** The model tag this instance asks for. */
export function localLlmModel(env: NodeJS.ProcessEnv = process.env): string {
	return env.LLM_MODEL ?? SETTINGS.LLM_MODEL.default;
}

export function isLocalLlmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.LLM_ENABLED === 'true' && (env.LLM_PROVIDER ?? 'ollama') === 'ollama';
}

/**
 * What `/api/tags` prints for a model, and what `sha256sum` of its manifest prints (measured equal on
 * Ollama 0.32.5). Lowercase only, because the comparison is exact: a value that can never equal a
 * listed digest would refuse every generation, so it is refused at boot where the operator reads.
 */
const MODEL_DIGEST = /^[0-9a-f]{64}$/;

/** The pinned digest, or `null` when none is set. An empty `.env` line is no pin. */
function modelDigestPin(env: NodeJS.ProcessEnv): string | null {
	return env.BP_LLM_MODEL_DIGEST ? env.BP_LLM_MODEL_DIGEST : null;
}

/** Boot check for `BP_LLM_MODEL_DIGEST` (#967): unset, empty, or a full digest. */
export function assertLlmModelDigestConfigured(env: NodeJS.ProcessEnv = process.env): void {
	const pin = modelDigestPin(env);
	if (pin === null || MODEL_DIGEST.test(pin)) return;
	throw new OperatorFacingError(
		`BP_LLM_MODEL_DIGEST must be 64 lowercase hexadecimal characters, the digest the model ` +
			`server lists for LLM_MODEL (received ${pin.length} characters). \`ollama list\` prints ` +
			'only the first 12; docs/reference/ai-model.md shows how to read the whole digest.'
	);
}

/** One shape for every giving-up path, so a code can never be omitted where `unavailable` is set. */
function unavailable(code: LocalLlmFailureCode, noWork = false): LocalLlmResult<never> {
	return {
		unavailable: true,
		failureCode: code,
		...(noWork ? { notCharged: true as const } : {})
	};
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
		const response = await fetchWithRedirectGuard(
			`${baseUrl}/api/version`,
			{ method: 'GET', signal: AbortSignal.timeout(connectTimeoutMs) },
			NO_REDIRECT
		);
		// Nothing here reads the body, so it is cancelled rather than bounded: zero bytes read is the
		// tightest bound, and a declared length is no reason to call a listening host unreachable.
		await response.body?.cancel();
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
	if (isOllamaBusy(caught)) return 'busy';
	return null;
};

/**
 * Ollama's client throws `ResponseError` with a `status_code`, and 404 on `/api/chat` means the
 * model tag is not pulled. Matched structurally rather than with `instanceof`, because the class is
 * internal to the package and not exported from its entry point: importing it would couple us to a
 * path outside the public surface, and the shape is the stable part.
 */
function isModelNotFound(caught: unknown): boolean {
	return isResponseError(caught, 404);
}

/**
 * Ollama answers 503 when its own queue is full (`OLLAMA_MAX_QUEUE`; `ErrMaxQueue` maps to
 * `http.StatusServiceUnavailable` in its server). The service is up and occupied, so this is `busy`
 * rather than the fallback's « not running » (#535).
 */
function isOllamaBusy(caught: unknown): boolean {
	return isResponseError(caught, 503);
}

function isResponseError(caught: unknown, status: number): boolean {
	if (typeof caught !== 'object' || caught === null) return false;
	const candidate = caught as { name?: unknown; status_code?: unknown };
	return candidate.name === 'ResponseError' && candidate.status_code === status;
}

/**
 * The connect leg alone: `null` when something answered at an allowlisted address inside the connect
 * budget, otherwise the failure. Exported so a caller holding a cache can ask it BEFORE reading the
 * cache, so a stopped model stops cached answers too (#535, spec F5).
 *
 * `requestLocalModel` runs it again, on purpose: a request may have waited in an admission room
 * since the caller's probe, and the ordering argument for `cold_start` below needs a probe that
 * answered for THIS generation.
 */
export async function probeLocalLlm(
	env: NodeJS.ProcessEnv = process.env
): Promise<LocalLlmResult<never> | null> {
	const baseUrl = getLocalBaseUrl(env.LLM_BASE_URL ?? DEFAULT_BASE_URL, env);
	// Refused by the host allowlist, before any socket is opened. Distinct from "nothing answered":
	// no amount of waiting fixes a base URL the allowlist will not accept.
	if (!baseUrl) return unavailable('not_configured', true);
	const connectTimeoutMs = readIntegerSetting('LLM_CONNECT_TIMEOUT_MS', env);
	return (await probeLocalLlmReachable(baseUrl, connectTimeoutMs, env))
		? null
		: unavailable('unreachable', true);
}

/**
 * THE MODEL HOST GETS NO REDIRECT (#967; #215 allowed one to an allowlisted host). Ollama answers its
 * endpoints directly and never redirects, and a followed redirect breaks the one thing the model list
 * is read for: a 307 from `/api/chat` to another port of an allowlisted host carries the prompt to a
 * server whose model nobody listed, while the answer comes back under the first server's digest
 * (contradiction pass on the final code). So every request to the host refuses every 3xx, which also
 * keeps the data on the base URL's host and nowhere else on the allowlist.
 */
const NO_REDIRECT = { isRedirectTargetAllowed: () => false };

/** Raised by the capped reader: the model host sent more than the bound its request earned. */
class ModelHostResponseTooLarge extends Error {
	override name = 'ModelHostResponseTooLarge';
}

/**
 * THE ONE READER FOR A BODY FROM THE MODEL HOST (#967). Before it, `/api/chat` was read whole by the
 * `ollama` client's `response.json()`: a fake host answering 200 MB raised the server's memory from
 * 319 MB to 1.17 GB, and a 64 MiB answer was read to its last byte (measured in
 * `modelHostBounds.spec.ts`). `num_predict` bounds what an honest model WRITES; nothing bounded what a
 * server SENDS.
 *
 * The body handed on errors the moment it passes `maxBytes`, which cancels the socket, whatever
 * length the host declared: a check on `Content-Length` first was break-checked and changed nothing
 * observable, since the count stops a declared body at the same bound. `overflow.hit` records
 * that it happened, because the `ollama` client swallows a body error on a non-2xx status and reports
 * only the status (`checkOk`), so the error alone would read as « model not pulled » on a 404.
 *
 * Every body the app reads from the model host passes here: the model list and the generation (the
 * client's injected `fetch`). The probe reads no body and cancels it instead.
 */
async function fetchModelHost(
	url: string,
	init: RequestInit,
	maxBytes: number,
	overflow: { hit: boolean }
): Promise<Response> {
	const response = await fetchWithRedirectGuard(url, init, NO_REDIRECT);
	if (response.body === null) return response;
	let read = 0;
	const capped = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				read += chunk.byteLength;
				if (read > maxBytes) {
					overflow.hit = true;
					controller.error(
						new ModelHostResponseTooLarge(`the model host sent more than ${maxBytes} bytes`)
					);
					return;
				}
				controller.enqueue(chunk);
			}
		})
	);
	return new Response(capped, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});
}

/**
 * HOW MANY BYTES AN HONEST ANSWER TO `format` CAN TAKE, derived from the schema and never a literal
 * (#967; the same rule `num_predict` was held to after #524).
 *
 * Counted in GRAMMAR CHARACTERS, then multiplied by the most bytes one of them can cost on the wire:
 *
 * - Ollama compiles `format` with llama.cpp's converter. A string of `maxLength` N is N grammar
 *   characters, and the grammar lets each be written as a `\uXXXX` escape.
 * - Ollama's Go encoder then escapes that escape's backslash (2 bytes) and writes `<`, `>`, `&` as
 *   `<` and kin (6 bytes; measured on 0.32.5). So one grammar character costs at most 7 bytes:
 *   `\uXXXX` becomes `\\uXXXX`. A raw astral character is 4.
 * - Every slot the grammar's space rule fills takes up to 22 characters: `| " " | "\n"{1,2} [ \t]{0,20}`,
 *   the only space rule in the 0.32.5 image (found in `libllama-common.so`). A slot follows `{`, `[`,
 *   `:`, `,`, every key and every value.
 *
 * Throws on a node it cannot bound (a string with neither `maxLength` nor `enum`, an array without
 * `maxItems` and `items`, an object open to extra keys, any other type), because sizing it as zero
 * refuses every answer and sizing it as infinity is no bound (F7 in the gateway design).
 */
const GRAMMAR_SPACE_CHARS = 22;
const WORST_BYTES_PER_GRAMMAR_CHAR = 7;
/**
 * The chat envelope around `message.content`: measured at 308 bytes with a 12-character model name on
 * Ollama 0.32.5 (eleven fields, all numbers, dates and fixed words). 2048 covers it six times over;
 * the model name, which Ollama echoes, is counted separately at 6 bytes per byte.
 */
const CHAT_ENVELOPE_BYTES = 2048;
/**
 * The model list is the one body whose size the request cannot derive: it grows with the models the
 * operator pulled. One entry measured 410 bytes on 0.32.5, so 1 MiB lists about 2500 models.
 */
const MODEL_LIST_MAX_BYTES = 1024 * 1024;

type JsonSchemaNode = {
	type?: unknown;
	enum?: unknown;
	maxLength?: unknown;
	maxItems?: unknown;
	items?: unknown;
	properties?: unknown;
	additionalProperties?: unknown;
};

function maxGrammarChars(node: JsonSchemaNode): number {
	const space = GRAMMAR_SPACE_CHARS;
	if (node.type === 'string') {
		if (Array.isArray(node.enum)) {
			return Math.max(...node.enum.map((member) => JSON.stringify(member).length)) + space;
		}
		if (typeof node.maxLength !== 'number') {
			throw new Error('answerByteBound: a string node needs maxLength or enum');
		}
		return node.maxLength + 2 + space;
	}
	if (node.type === 'array') {
		if (typeof node.maxItems !== 'number' || typeof node.items !== 'object' || !node.items) {
			throw new Error('answerByteBound: an array node needs maxItems and items');
		}
		const item = maxGrammarChars(node.items as JsonSchemaNode);
		// `[` space, the items with `,` space between them, `]` space.
		return (
			1 + space + node.maxItems * item + Math.max(0, node.maxItems - 1) * (1 + space) + 1 + space
		);
	}
	if (node.type === 'object') {
		if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
			throw new Error('answerByteBound: an object node open to extra keys has no bound');
		}
		// llama.cpp closes an object only when it names `properties` or `additionalProperties`: a
		// bare `{type: 'object'}` compiles to its generic rule, which admits any object.
		if (node.properties === undefined && node.additionalProperties !== false) {
			throw new Error('answerByteBound: an object node with no properties admits any object');
		}
		const entries = Object.entries((node.properties ?? {}) as Record<string, JsonSchemaNode>);
		// Each `"key"` space `:` space value; `,` space between entries; `{` space and `}` space around.
		const body = entries.reduce(
			(total, [key, value]) =>
				total + JSON.stringify(key).length + space + 1 + space + maxGrammarChars(value),
			0
		);
		return 1 + space + body + Math.max(0, entries.length - 1) * (1 + space) + 1 + space;
	}
	throw new Error(`answerByteBound: cannot bound a ${JSON.stringify(node.type)} node`);
}

function answerByteBound(format: Record<string, unknown>, model: string): number {
	return (
		maxGrammarChars(format) * WORST_BYTES_PER_GRAMMAR_CHAR +
		CHAT_ENVELOPE_BYTES +
		Buffer.byteLength(model) * 6
	);
}

/**
 * A model name as Ollama reads it, so the configured name and the listed one compare as Ollama
 * compares them: the default registry and the `library` namespace dropped (as `ollama list` prints
 * them), `:latest` added when the LAST path segment carries no tag (a registry port is not a tag),
 * and case folded (Ollama's own name equality ignores case).
 */
function ollamaShortName(name: string): string {
	const tagged = name.slice(name.lastIndexOf('/') + 1).includes(':') ? name : `${name}:latest`;
	return tagged
		.replace(/^registry\.ollama\.ai\//i, '')
		.replace(/^library\//i, '')
		.toLowerCase();
}

const modelListSchema = z.object({
	models: z.array(
		z.object({
			name: z.string(),
			model: z.string().optional(),
			digest: z.string(),
			remote_host: z.string().optional(),
			remote_model: z.string().optional(),
			details: z.object({ format: z.string().optional() }).optional()
		})
	)
});

/**
 * Which model would answer, read from `/api/tags` (the only Ollama endpoint carrying a digest;
 * `/api/show` carries none, measured on 0.32.5). A failure code when it cannot be known. Within the
 * CONNECT budget, because listing loads no model: a list that never comes is a host not answering.
 */
async function readModelIdentity(
	baseUrl: string,
	model: string,
	env: NodeJS.ProcessEnv,
	signal: AbortSignal | undefined
): Promise<ModelIdentity | LocalLlmFailureCode> {
	const budget = AbortSignal.timeout(readIntegerSetting('LLM_CONNECT_TIMEOUT_MS', env));
	const overflow = { hit: false };
	let response: Response;
	let text: string;
	try {
		response = await fetchModelHost(
			`${baseUrl}/api/tags`,
			{ method: 'GET', signal: signal ? AbortSignal.any([budget, signal]) : budget },
			MODEL_LIST_MAX_BYTES,
			overflow
		);
		text = await response.text();
	} catch {
		// Over the bound is a list that cannot be read; anything else (the budget, a reset, a refused
		// redirect) is the host not answering, the same reading the probe gives it.
		return overflow.hit ? 'model_unidentified' : 'unreachable';
	}
	if (!response.ok) return 'model_unidentified';
	let parsed: ReturnType<typeof modelListSchema.safeParse>;
	try {
		parsed = modelListSchema.safeParse(JSON.parse(text));
	} catch {
		return 'model_unidentified';
	}
	if (!parsed.success) return 'model_unidentified';
	const listed = parsed.data;
	const wanted = ollamaShortName(model);
	const entry = listed.models.find(
		(candidate) =>
			ollamaShortName(candidate.name) === wanted ||
			(candidate.model !== undefined && ollamaShortName(candidate.model) === wanted)
	);
	if (!entry) return 'model_unavailable';
	// An Ollama `-cloud` tag: listed here, generated on ollama.com (measured on 0.32.5). The prompt
	// would leave for a host no allowlist names.
	if (entry.remote_host || entry.remote_model) return 'model_remote';
	if (!MODEL_DIGEST.test(entry.digest)) return 'model_unidentified';
	return { digest: entry.digest, format: entry.details?.format ?? '' };
}

/** One generation: what the caller asks, and the two things that bound what may come back. */
export interface LocalModelRequest<T> {
	prompt: string;
	/**
	 * The answer's JSON schema, sent as Ollama's `format`, which compiles it into a grammar. Bounds an
	 * honest model only: `schema` below is what decides, because a hostile one follows no grammar.
	 */
	format: Record<string, unknown>;
	/** Validates the parsed answer; anything it refuses is `response_unusable` or `_truncated`. */
	schema: ZodType<T>;
	/**
	 * The generation ceiling, sent as `num_predict`. DERIVED by the caller from the largest answer its
	 * schema admits, never a literal: a literal 512 outlived the schema it was sized for and cut every
	 * full answer short (#524).
	 */
	numPredict: number;
}

/**
 * THE MODEL CALL, with no caller in 1.3 (decision record #1009): the dashboard advice that used it
 * was removed (#1010), and the connection is kept as a library for the next feature to name one.
 *
 * `signal` is the caller's: a newer request, an opt-out, or a closed tab (#535). It joins the
 * generation budget rather than replacing it, so either one ends the fetch, and Ollama stops
 * generating when the connection closes. An abort from it reads as `cold_start` here, because
 * `isTimeoutError` accepts `AbortError`; a caller checks its own signal BEFORE reading the result
 * for exactly that reason.
 */
export async function requestLocalModel<T>(
	request: LocalModelRequest<T>,
	env: NodeJS.ProcessEnv = process.env,
	signal?: AbortSignal
): Promise<LocalLlmResult<T> | null> {
	if (!isLocalLlmEnabled(env)) return null;

	const model = localLlmModel(env);
	// Before any socket: a format the transport cannot bound is the caller's mistake, said as a throw
	// rather than as a failure code the reader would be told to act on.
	const answerBound = answerByteBound(request.format, model);

	const refused = await probeLocalLlm(env);
	if (refused) return refused;
	// Non-null: the probe above returned null only after this same call accepted the address.
	const baseUrl = getLocalBaseUrl(env.LLM_BASE_URL ?? DEFAULT_BASE_URL, env)!;

	// Which weights would answer, before asking them anything (#967). Each refusal here is before
	// any generation, so none is charged.
	const before = await readModelIdentity(baseUrl, model, env, signal);
	if (typeof before === 'string') return unavailable(before, true);
	const pin = modelDigestPin(env);
	if (pin !== null && before.digest !== pin) return unavailable('model_mismatch', true);

	// Refused rather than replaced by the default (#754): `0x10` used to read as 16 ms. The boot
	// checks refuse the same values before any request reaches this.
	const timeoutMs = readIntegerSetting('LLM_TIMEOUT_MS', env);
	const overflow = { hit: false };

	const client = new Ollama({
		host: baseUrl,
		// #215: guard redirects here too. The base URL is allowlisted (getLocalBaseUrl above), but a
		// redirect could still bounce the fetch to a non-allowlisted host; every redirect target is
		// re-validated against the same allowlist, inside `fetchModelHost`, which also bounds the body
		// the client reads (#967).
		fetch: (input, init) =>
			fetchModelHost(
				typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
				{
					...init,
					signal: signal
						? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
						: AbortSignal.timeout(timeoutMs)
				},
				answerBound,
				overflow
			)
	});

	try {
		const response = await client.chat({
			model,
			messages: [{ role: 'user', content: request.prompt }],
			format: request.format,
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
				// The caller's, derived from its schema: see `LocalModelRequest.numPredict`.
				num_predict: request.numPredict
			}
		});

		// `done_reason` has always been on this response and nothing read it. It is the one field that
		// separates "the ceiling cut the answer off" from "the model produced something unreadable",
		// which are the same broken JSON string and opposite advice to the person reading the card.
		const truncated = response.done_reason === 'length';

		const content = response.message?.content;
		if (!content) return unreadable(truncated);

		const parsed = parseLocalLlmContent(content, request.schema, truncated);
		if (parsed.unavailable) return parsed;
		// Confirmed AFTER the answer, because a pull finishing between the first read and the
		// generation runs other weights under the first read's record. The generation ran, so charged.
		const after = await readModelIdentity(baseUrl, model, env, signal);
		if (typeof after === 'string') return unavailable(after);
		if (after.digest !== before.digest) return unavailable('model_mismatch');
		return { value: parsed.value, model: before };
	} catch (caught) {
		// Before the status: the client reports a body error on a non-2xx answer as that status alone.
		if (overflow.hit) return unavailable('response_unusable');
		// `unreachable` is the fallback rather than a catch-all sentence: the probe answered, so
		// anything unrecognised here is the connection having failed since, which is the honest
		// reading and the one whose advice ("check that it is running") stays true.
		// No work done only where it is KNOWN (404, 503 before generating); the catch-all is not,
		// because a 500 or a reset can arrive after the GPU did the whole generation (#535).
		return unavailable(
			failureCode(caught, recogniseLocalLlmFailure, LOCAL_LLM_FALLBACK_CODE),
			isModelNotFound(caught) || isOllamaBusy(caught)
		);
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
function unreadable(truncated: boolean): LocalLlmResult<never> {
	return unavailable(truncated ? 'response_truncated' : 'response_unusable');
}

function parseLocalLlmContent<T>(
	content: string,
	schema: ZodType<T>,
	truncated: boolean
): { value: T; unavailable?: undefined } | LocalLlmResult<never> {
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(content);
	} catch {
		// The reported shape: a 200 in 4.7 s whose JSON stops mid-object because the generation ran out
		// of tokens. Valid JSON up to the cut, and `JSON.parse` fails on the last character.
		return unreadable(truncated);
	}

	const parsed = schema.safeParse(parsedJson);
	if (!parsed.success) return unreadable(truncated);

	// Half 2 of the rule stated beside `unreadable`: a schema-valid answer is kept whatever stopped
	// the generation, so `truncated` is deliberately not read from here on.
	return { value: parsed.data };
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

/**
 * The model host, when it is not on this machine and the connection would send to it (#967,
 * ANSSI-PA-102 R34); `null` when the connection is off or its base URL is refused, because nothing
 * is then sent anywhere. Startup names it, because whatever a feature sends the model leaves this
 * machine for it.
 *
 * Only the base URL's host is judged: the model host gets no redirect (`NO_REDIRECT`), so no other
 * allowlisted host is ever sent anything.
 *
 * « This machine » is the loopback names, `host.docker.internal`, and a SINGLE-LABEL name the
 * operator declares internal in `LLM_HTTP_PERMITTED_HOSTS`, which is how the AI overlay declares its
 * `ollama` container (a Compose service name has no dot). A dotted name or an address declared there
 * is still named: a declaration that plain http is acceptable is not proof the host is local. The
 * known limit is a single-label name for another machine, which is taken at the operator's word.
 */
export function remoteModelHost(env: Record<string, string | undefined>): string | null {
	if (!isLocalLlmEnabled(env)) return null;
	const baseUrl = getLocalBaseUrl(env.LLM_BASE_URL ?? DEFAULT_BASE_URL, env);
	if (baseUrl === null) return null;
	const host = new URL(baseUrl).hostname;
	const declared = getHttpPermittedHosts(env).includes(host);
	const onThisMachine =
		DEFAULT_HTTP_PERMITTED_HOSTS.includes(host) ||
		(declared && !host.includes('.') && !host.includes(':'));
	return onThisMachine ? null : host;
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
