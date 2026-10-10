import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import path from 'node:path';
import { test } from '@playwright/test';
import { REAL_MODEL_FIXTURES, FIXTURES } from '../../src/lib/server/ai/qualification/corpus';
import {
	askAdvice,
	bootAiInstance,
	registerMembers,
	seedMember,
	type AiInstance
} from '../support/aiInstance';
import { numeralsIn } from '../support/aiReading';

/**
 * `npm run ai:check` (#971): the BUILD, a real database, a real browser and a REAL model. Between
 * the app and Ollama sits a recording proxy, so each run is read twice: as the app's verdict (the
 * JSON `/insights/advice` answered, after every rule the app applies) and as the RAW answer the
 * model wrote (before any of them). The canary, the misreads and the numerals are read from the raw
 * answer, so a later output rule that hides them cannot make this report look cleaner.
 *
 * This spec RECORDS and does not judge: it writes the report and `scripts/ai-check-report.mjs`
 * decides, refusing a missing, empty or short report. A reporter that swallowed a figure cannot
 * make that step pass.
 *
 * One member per (fixture, run), because the gateway caches answers per member by prompt: a second
 * press with the same data would be answered from the cache and never reach the model.
 *
 * Point it at an Ollama of its own, never the one a running instance uses (AISVS C3.4.1).
 */

const OLLAMA_URL = process.env.BP_AI_CHECK_OLLAMA_URL;
const MODEL = process.env.BP_AI_CHECK_MODEL ?? process.env.LLM_MODEL;
const RUNS = Number(process.env.BP_AI_CHECK_RUNS ?? '3');
const REPORT = path.resolve(process.env.BP_AI_CHECK_REPORT ?? 'test-results/ai-check/report.json');
const PORT = 4195;
const PROXY_PORT = 4196;
/** The setting's own ceiling: a CPU model is measured, not timed out. Latency is reported apart. */
const GENERATION_TIMEOUT_MS = 600_000;

interface Chat {
	at: number;
	durationMs: number;
	status: number;
	request: { model?: string; messages?: { role: string; content: string }[] };
	response: {
		message?: { content?: string };
		done_reason?: string;
		eval_count?: number;
		prompt_eval_count?: number;
		load_duration?: number;
		total_duration?: number;
	} | null;
}

const chats: Chat[] = [];
let proxy: Server | undefined;
let instance: AiInstance | undefined;

/**
 * The three paths the app calls on Ollama, returned as CONSTANTS. The proxy forwards nothing else
 * and never builds the upstream address from what it received: a request in absolute form
 * (`GET http://elsewhere/ HTTP/1.1`) would otherwise resolve to another host (CodeQL, SSRF).
 */
function ollamaPath(
	received: string | undefined
): '/api/chat' | '/api/version' | '/api/tags' | null {
	const pathname = new URL(received ?? '/', 'http://proxy.invalid').pathname;
	if (pathname === '/api/chat') return '/api/chat';
	if (pathname === '/api/version') return '/api/version';
	if (pathname === '/api/tags') return '/api/tags';
	return null;
}

function startProxy(target: URL): Promise<void> {
	proxy = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			const body = Buffer.concat(chunks);
			const started = Date.now();
			const upstreamPath = ollamaPath(req.url);
			if (!upstreamPath) {
				res.writeHead(404).end();
				return;
			}
			const upstream = httpRequest(
				new URL(upstreamPath, target.origin),
				// No accept-encoding upstream: a compressed answer would reach the app intact and the
				// recorder as unparsable bytes, which would blind every detector below while the run reads clean.
				{ method: req.method, headers: { ...withoutEncoding(req.headers), host: target.host } },
				(answer) => {
					const back: Buffer[] = [];
					answer.on('data', (chunk: Buffer) => back.push(chunk));
					answer.on('end', () => {
						const raw = Buffer.concat(back);
						if (upstreamPath === '/api/chat') {
							chats.push({
								at: started,
								durationMs: Date.now() - started,
								status: answer.statusCode ?? 0,
								request: JSON.parse(body.toString('utf8')),
								response: parseOrNull(raw.toString('utf8'))
							});
						}
						res.writeHead(answer.statusCode ?? 502, answer.headers).end(raw);
					});
				}
			);
			upstream.on('error', () => res.writeHead(502).end());
			upstream.end(body);
		});
	});
	return new Promise((resolve) => proxy!.listen(PROXY_PORT, '127.0.0.1', resolve));
}

function withoutEncoding(headers: Record<string, string | string[] | undefined>) {
	const copy = { ...headers };
	delete copy['accept-encoding'];
	return copy;
}

/** The budget the app gives a generation by default, read where it is written for operators. */
function appTimeoutMs(): number {
	const match = /^LLM_TIMEOUT_MS=(\d+)\s*$/m.exec(readFileSync('.env.example', 'utf8'));
	if (!match) throw new Error('ai:check: LLM_TIMEOUT_MS not found in .env.example');
	return Number(match[1]);
}

/**
 * The positive control for the canary: the same request made directly to the model, outside the
 * app. If the model does not write the canary when asked plainly, a run where it never obeyed the
 * planted instruction says nothing about it.
 */
async function askDirectly(target: URL, model: string, ask: string): Promise<string> {
	const response = await fetch(new URL('/api/chat', target), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			model,
			messages: [{ role: 'user', content: ask }],
			stream: false,
			think: false,
			options: { temperature: 0.2 }
		})
	});
	const body = (await response.json()) as { message?: { content?: string } };
	return body.message?.content ?? '';
}

function parseOrNull(text: string): Chat['response'] {
	try {
		return JSON.parse(text) as Chat['response'];
	} catch {
		return null;
	}
}

function readRow(
	chat: Chat | undefined,
	canary?: RegExp,
	misreads?: { name: string; pattern: RegExp }[]
) {
	const prompt = (chat?.request.messages ?? []).map((m) => m.content).join('\n');
	const raw = chat?.response?.message?.content ?? '';
	const inPrompt = new Set(numeralsIn(prompt));
	return {
		doneReason: chat?.response?.done_reason ?? null,
		evalCount: chat?.response?.eval_count ?? null,
		promptEvalCount: chat?.response?.prompt_eval_count ?? null,
		loadMs: chat?.response?.load_duration ? Math.round(chat.response.load_duration / 1e6) : null,
		generationMs: chat?.durationMs ?? null,
		canaryEcho: canary ? canary.test(raw) : null,
		misreads: (misreads ?? []).filter((m) => m.pattern.test(raw)).map((m) => m.name),
		numeralsNotInPrompt: numeralsIn(raw).filter((n) => !inPrompt.has(n)),
		raw,
		prompt
	};
}

test.describe.configure({ mode: 'serial', retries: 0 });

test('ai:check records the configured real model on every qualification fixture', async ({
	browser
}) => {
	if (!OLLAMA_URL) throw new Error('ai:check: set BP_AI_CHECK_OLLAMA_URL to an Ollama of its own');
	if (!MODEL) throw new Error('ai:check: set BP_AI_CHECK_MODEL (or LLM_MODEL) to the tag to check');
	if (!Number.isInteger(RUNS) || RUNS < 1)
		throw new Error('ai:check: BP_AI_CHECK_RUNS must be a positive integer');
	test.setTimeout(REAL_MODEL_FIXTURES.length * RUNS * (GENERATION_TIMEOUT_MS + 60_000));

	const target = new URL(OLLAMA_URL);
	const version = (await (await fetch(new URL('/api/version', target))).json()) as {
		version: string;
	};
	const tags = (await (await fetch(new URL('/api/tags', target))).json()) as {
		models: { name: string; digest: string; size: number; details?: Record<string, unknown> }[];
	};
	const pulled = tags.models.find((model) => model.name === MODEL);
	if (!pulled) throw new Error(`ai:check: ${MODEL} is not pulled on ${target.host}`);

	const realModelCanaries = [];
	for (const entry of REAL_MODEL_FIXTURES) {
		if (!entry.canary) continue;
		const raw = await askDirectly(target, MODEL, entry.canary.ask);
		realModelCanaries.push({ fixture: entry.fixture, fired: entry.canary.pattern.test(raw), raw });
	}

	await startProxy(target);
	instance = await bootAiInstance({
		name: 'ai-check',
		port: PORT,
		llmBaseUrl: `http://127.0.0.1:${PROXY_PORT}`,
		env: { LLM_MODEL: MODEL, LLM_TIMEOUT_MS: String(GENERATION_TIMEOUT_MS) }
	});

	const plan = REAL_MODEL_FIXTURES.flatMap((entry) =>
		Array.from({ length: RUNS }, (_, run) => ({
			...entry,
			run,
			email: `ai-check-${entry.fixture}-${run}@budgetpilot.test`
		}))
	);
	await registerMembers(instance, [`ai-check-admin@budgetpilot.test`, ...plan.map((p) => p.email)]);

	const rows = [];
	try {
		for (const entry of plan) {
			const fixture = FIXTURES[entry.fixture];
			const member = await seedMember(instance, entry.email, [...fixture.transactions], {
				includeLabels: 'includeLabels' in fixture && fixture.includeLabels
			});
			const before = chats.length;
			const answer = await askAdvice(browser, instance, member, {
				timeoutMs: GENERATION_TIMEOUT_MS + 30_000
			});
			await answer.page.context().close();
			const chat = chats.length === before + 1 ? chats.at(-1) : undefined;
			rows.push({
				fixture: entry.fixture,
				run: entry.run,
				chatsForThisPress: chats.length - before,
				verdict: answer.json.unavailable ? (answer.json.failureCode ?? 'unavailable') : 'advice',
				cancelled: answer.json.cancelled === true,
				insightsShown: answer.json.insights.length,
				...readRow(chat, entry.canary?.pattern, entry.misreads)
			});
		}
	} finally {
		// The detectors' own calibration, written beside what they found: each must fire on a planted
		// positive and stay silent on its negative, or the report script refuses every figure above.
		const calibration = {
			canaryFiresOnPlanted: readRow(
				{
					at: 0,
					durationMs: 0,
					status: 200,
					request: { messages: [] },
					response: { message: { content: '{"summary":"Zorblax"}' } }
				},
				REAL_MODEL_FIXTURES.find((f) => f.fixture === 'injection-en')!.canary!.pattern
			).canaryEcho,
			canarySilentOnQuote: readRow(
				{
					at: 0,
					durationMs: 0,
					status: 200,
					request: { messages: [] },
					response: { message: { content: 'the category (Z-O-R-B-L-A-X) is small' } }
				},
				REAL_MODEL_FIXTURES.find((f) => f.fixture === 'injection-en')!.canary!.pattern
			).canaryEcho,
			canarySilentOnClean: readRow(
				{
					at: 0,
					durationMs: 0,
					status: 200,
					request: { messages: [] },
					response: { message: { content: 'Groceries are steady.' } }
				},
				REAL_MODEL_FIXTURES.find((f) => f.fixture === 'injection-en')!.canary!.pattern
			).canaryEcho,
			misreadFiresOnPlanted: REAL_MODEL_FIXTURES.find(
				(f) => f.fixture === 'month-fr'
			)!.misreads![0].pattern.test('Your education spending'),
			numeralFiresOnPlanted: numeralsIn('spent ٩٨٧٦٥ and 98765').join(','),
			numeralGroundedIsSilent: readRow({
				at: 0,
				durationMs: 0,
				status: 200,
				request: { messages: [{ role: 'user', content: '{"amount":145.3}' }] },
				response: { message: { content: 'You spent 145.30.' } }
			}).numeralsNotInPrompt.length,
			numeralThousandsIsSilent: readRow({
				at: 0,
				durationMs: 0,
				status: 200,
				request: { messages: [{ role: 'user', content: '{"income":2100}' }] },
				response: { message: { content: 'Your income was 2,100.00.' } }
			}).numeralsNotInPrompt.length,
			realModelCanaries
		};
		mkdirSync(path.dirname(REPORT), { recursive: true });
		writeFileSync(
			REPORT,
			JSON.stringify(
				{
					model: MODEL,
					digest: pulled.digest,
					sizeBytes: pulled.size,
					details: pulled.details ?? null,
					ollamaVersion: version.version,
					runs: RUNS,
					fixtures: REAL_MODEL_FIXTURES.map((f) => f.fixture),
					expectedRows: plan.length,
					proxyChats: chats.length,
					appTimeoutMs: appTimeoutMs(),
					day: new Date().toISOString().slice(0, 10),
					calibration,
					rows
				},
				null,
				'\t'
			)
		);
	}
});

test.afterAll(() => {
	instance?.stop();
	proxy?.close();
});
