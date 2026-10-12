import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { requestLocalModel, type LocalModelRequest } from './local-llm';

/**
 * #967: what the transport READS from the model host, measured on a real socket.
 *
 * A real HTTP server rather than a `fetch` spy, because the figure under test is how many bytes the
 * app pulled off the wire, and a spy hands over a whole `Response` whose body was never on one. The
 * server writes with backpressure, so `bytesAccepted` is what the client read plus what the two
 * kernel socket buffers hold, which is why the bound asserted below has a margin of megabytes while
 * the unbounded reading it separates from is the whole 64 MiB.
 */

const MIB = 1024 * 1024;
/** The hostile answer: far above any bound a schema derives, far below what a test can afford. */
const HOSTILE_BYTES = 64 * MIB;
/** Kernel send and receive buffers on loopback stay well under this; the whole body does not. */
const READ_MARGIN = 16 * MIB;

/** The digest `/api/tags` reports for the model the fake host serves. 64 hex, as Ollama prints it. */
const DIGEST = 'a8b0c51577010a738c3a6f8f2d5e3a1f4c1e0b9d8a7f6e5d4c3b2a1908172635';
const MODEL = 'qwen2.5:0.5b';

type Route = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

interface FakeHost {
	baseUrl: string;
	/** Body bytes the server managed to hand to the socket, per path. */
	bytesAccepted: Record<string, number>;
	/** How many requests reached each path. */
	hits: Record<string, number>;
	close: () => Promise<void>;
}

const hosts: FakeHost[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.close()));
});

function tagsBody(entries: { name: string; digest: string; format?: string }[]) {
	return JSON.stringify({
		models: entries.map((entry) => ({
			name: entry.name,
			model: entry.name,
			modified_at: '2026-08-30T10:00:00Z',
			size: 397_000_000,
			digest: entry.digest,
			details: { parent_model: '', format: entry.format ?? 'gguf', family: 'qwen2' },
			capabilities: ['completion']
		}))
	});
}

/** An honest chat envelope around `content`, serialised the way Ollama's Go encoder does. */
function chatBody(content: string) {
	return goJson({
		model: MODEL,
		created_at: '2026-10-12T10:00:00Z',
		message: { role: 'assistant', content },
		done_reason: 'stop',
		done: true,
		total_duration: 1_234_567_890,
		load_duration: 123_456_789,
		prompt_eval_count: 123,
		prompt_eval_duration: 12_345_678,
		eval_count: 45,
		eval_duration: 1_234_567
	});
}

/**
 * `JSON.stringify` plus what Go's `encoding/json` adds and JavaScript's does not: `<`, `>` and `&`
 * become `<`, `>`, `&`, six bytes for one character. Measured on Ollama 0.32.5: a `<`
 * inside `message.content` arrived as `<`.
 */
function goJson(value: unknown) {
	return JSON.stringify(value)
		.replaceAll('<', '\\u003c')
		.replaceAll('>', '\\u003e')
		.replaceAll('&', '\\u0026');
}

/** Writes `total` bytes of a JSON string body, honouring backpressure, and counts what was taken. */
async function streamHostileJson(
	res: ServerResponse,
	total: number,
	counter: (n: number) => void,
	declareLength: boolean
): Promise<void> {
	const head = '{"model":"x","message":{"role":"assistant","content":"';
	const tail = '"},"done":true,"done_reason":"stop"}';
	const fill = total - head.length - tail.length;
	res.writeHead(200, {
		'Content-Type': 'application/json',
		...(declareLength ? { 'Content-Length': String(total) } : {})
	});
	const chunk = Buffer.alloc(64 * 1024, 'a');
	const write = (buffer: Buffer | string) =>
		new Promise<boolean>((resolve) => {
			if (res.destroyed || res.writableEnded) return resolve(false);
			const ok = res.write(buffer, (error) => {
				if (!error) counter(Buffer.byteLength(buffer));
			});
			if (ok) return resolve(true);
			// A client that stopped reading never drains: give up after a second rather than hang.
			const timer = setTimeout(() => resolve(false), 1000);
			res.once('drain', () => {
				clearTimeout(timer);
				resolve(true);
			});
			res.once('close', () => {
				clearTimeout(timer);
				resolve(false);
			});
		});
	if (!(await write(head))) {
		res.destroy();
		return;
	}
	let left = fill;
	while (left > 0) {
		const piece = left >= chunk.length ? chunk : chunk.subarray(0, left);
		if (!(await write(piece))) {
			res.destroy();
			return;
		}
		left -= piece.length;
	}
	await write(tail);
	res.end();
}

async function fakeHost(routes: Record<string, Route>): Promise<FakeHost> {
	const bytesAccepted: Record<string, number> = {};
	const hits: Record<string, number> = {};
	const server = createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://x').pathname;
		hits[path] = (hits[path] ?? 0) + 1;
		const route = routes[path];
		if (!route) {
			res.writeHead(404).end();
			return;
		}
		// Every route reads its request body first, so a POST never races its own answer.
		req.resume();
		req.on('end', () => void route(req, res));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	const host: FakeHost = {
		baseUrl: `http://127.0.0.1:${port}`,
		bytesAccepted,
		hits,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
	hosts.push(host);
	return host;
}

const counterFor = (host: () => FakeHost, path: string) => (n: number) => {
	const accepted = host().bytesAccepted;
	accepted[path] = (accepted[path] ?? 0) + n;
};

const version: Route = (_req, res) => {
	res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"version":"0.32.5"}');
};
const tags =
	(body = tagsBody([{ name: MODEL, digest: DIGEST }])): Route =>
	(_req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
	};
const chat =
	(content: string): Route =>
	(_req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' }).end(chatBody(content));
	};

function envFor(host: FakeHost, extra: Record<string, string> = {}) {
	return {
		LLM_ENABLED: 'true',
		LLM_PROVIDER: 'ollama',
		LLM_BASE_URL: host.baseUrl,
		LLM_MODEL: MODEL,
		...extra
	};
}

/** A caller's request: one string of at most `maxLength` characters. */
function stringRequest(maxLength: number): LocalModelRequest<{ text: string }> {
	return {
		prompt: 'p',
		format: {
			type: 'object',
			properties: { text: { type: 'string', maxLength } },
			required: ['text']
		},
		// Deliberately looser than the format: the bound under test is the transport's, so the
		// caller's own validation must not be what refuses.
		schema: z.object({ text: z.string() }),
		numPredict: 64
	};
}

describe("the answer is read within a bound derived from the caller's schema (#967)", () => {
	// Separates a transport that reads whatever the host sends (today: all 64 MiB, the measured
	// defect, raising the server's memory from 319 MB to 1.17 GB on the issue's run) from one that
	// stops at the bound. Both framings, because a declared length and a chunked body reach the
	// reader by different paths.
	it.each([
		['chunked, no declared length', false],
		['a declared Content-Length', true]
	])('stops reading a hostile answer far above the bound (%s)', async (_label, declareLength) => {
		let host!: FakeHost;
		host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(),
			'/api/chat': (_req, res) =>
				streamHostileJson(
					res,
					HOSTILE_BYTES,
					counterFor(() => host, '/api/chat'),
					declareLength
				)
		});
		await requestLocalModel(stringRequest(200), envFor(host));
		const read = host.bytesAccepted['/api/chat'] ?? 0;
		expect(
			read,
			`bytes the server handed to the socket before the client stopped: ${read}`
		).toBeLessThan(READ_MARGIN);
	});

	it('names the refusal as an unusable answer the model was charged for', async () => {
		let host!: FakeHost;
		host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(),
			'/api/chat': (_req, res) =>
				streamHostileJson(
					res,
					HOSTILE_BYTES,
					counterFor(() => host, '/api/chat'),
					false
				)
		});
		const result = await requestLocalModel(stringRequest(200), envFor(host));
		expect(result).toEqual({ unavailable: true, failureCode: 'response_unusable' });
	});

	// Separates a bound derived from the caller's FORMAT from a fixed one: the same 20 000-character
	// answer is read under a format admitting it and refused under one admitting 100 characters,
	// while the caller's own schema accepts both. Today both are read.
	it('derives the bound from the format: the same answer is read under one and refused under the other', async () => {
		const answer = JSON.stringify({ text: 'x'.repeat(20_000) });
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(),
			'/api/chat': chat(answer)
		});
		const admitted = await requestLocalModel(stringRequest(20_000), envFor(host));
		expect(admitted?.value).toEqual({ text: 'x'.repeat(20_000) });
		const refused = await requestLocalModel(stringRequest(100), envFor(host));
		expect(refused).toEqual({ unavailable: true, failureCode: 'response_unusable' });
	});

	// The other direction, which a bound that is too small fails silently in: an HONEST answer at the
	// schema's maximum, every character one Ollama escapes to six bytes, is still read. Separates a
	// byte factor that covers Go's escaping from one sized for plain ASCII.
	it('reads an honest answer at the schema maximum whose every character Ollama escapes', async () => {
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(),
			'/api/chat': chat(JSON.stringify({ text: '<'.repeat(2_000) }))
		});
		const result = await requestLocalModel(stringRequest(2_000), envFor(host));
		expect(result?.value).toEqual({ text: '<'.repeat(2_000) });
	});

	// The grammar lets an honest model write any character as a `\uXXXX` escape, and Ollama's encoder
	// then escapes that backslash: seven bytes on the wire for one character of the answer. Separates
	// a factor of 7 from one of 6, which the raw `<` case above cannot (6 bytes each); 20 000
	// characters, so the envelope's slack cannot absorb the difference.
	it('reads an honest answer at the schema maximum written entirely in escapes', async () => {
		const escaped = `{"text":"${'\\u003c'.repeat(20_000)}"}`;
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(),
			'/api/chat': chat(escaped)
		});
		const result = await requestLocalModel(stringRequest(20_000), envFor(host));
		expect(result?.value).toEqual({ text: '<'.repeat(20_000) });
	});

	// A schema the transport cannot bound is the caller's mistake and is said so before any socket
	// opens, rather than sized as zero (which would refuse every answer) or as infinity (no bound).
	it.each([
		['a string with neither maxLength nor enum', { type: 'string' }, /string.*maxLength or enum/],
		[
			'an array with no maxItems',
			{ type: 'array', items: { type: 'string', maxLength: 3 } },
			/maxItems/
		],
		['a number', { type: 'number' }, /number/]
	])('refuses to send a format it cannot bound: %s', async (_label, node, reason) => {
		const host = await fakeHost({ '/api/version': version, '/api/tags': tags() });
		const request = {
			...stringRequest(10),
			format: { type: 'object', properties: { text: node }, required: ['text'] }
		};
		await expect(requestLocalModel(request, envFor(host))).rejects.toThrow(reason);
		expect(host.hits['/api/chat'] ?? 0).toBe(0);
	});
});

describe('the model is named by digest (#967)', () => {
	const answer = JSON.stringify({ text: 'ok' });

	// Separates a transport that never asks which weights answer (today) from one that reads the
	// digest and the format of the model it is about to call, and hands them to its caller.
	it('reports the digest and format of the model that answered', async () => {
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(),
			'/api/chat': chat(answer)
		});
		const result = await requestLocalModel(stringRequest(10), envFor(host));
		expect(result).toEqual({ value: { text: 'ok' }, model: { digest: DIGEST, format: 'gguf' } });
	});

	it('answers with a pinned digest that matches', async () => {
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(),
			'/api/chat': chat(answer)
		});
		const result = await requestLocalModel(
			stringRequest(10),
			envFor(host, { BP_LLM_MODEL_DIGEST: DIGEST })
		);
		expect(result?.value).toEqual({ text: 'ok' });
	});

	// Separates a pin that is read from one that is decorative: a different digest under the same
	// tag is refused, and no generation is asked for.
	it('refuses a different model under the same tag when a digest is pinned, before generating', async () => {
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(),
			'/api/chat': chat(answer)
		});
		const result = await requestLocalModel(
			stringRequest(10),
			envFor(host, { BP_LLM_MODEL_DIGEST: 'f'.repeat(64) })
		);
		expect(result).toEqual({ unavailable: true, failureCode: 'model_mismatch', notCharged: true });
		expect(host.hits['/api/chat'] ?? 0).toBe(0);
	});

	it('refuses a model the host does not list, before generating', async () => {
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(tagsBody([{ name: 'other:1b', digest: DIGEST }])),
			'/api/chat': chat(answer)
		});
		const result = await requestLocalModel(stringRequest(10), envFor(host));
		expect(result).toEqual({
			unavailable: true,
			failureCode: 'model_unavailable',
			notCharged: true
		});
		expect(host.hits['/api/chat'] ?? 0).toBe(0);
	});

	// Ollama's own default: a name with no tag means `:latest`, and `/api/tags` lists it with it.
	it('finds an untagged model name under :latest', async () => {
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(tagsBody([{ name: 'qwen2.5:latest', digest: DIGEST }])),
			'/api/chat': chat(answer)
		});
		const result = await requestLocalModel(
			stringRequest(10),
			envFor(host, { LLM_MODEL: 'qwen2.5' })
		);
		expect(result).toEqual({ value: { text: 'ok' }, model: { digest: DIGEST, format: 'gguf' } });
	});

	// A list the app cannot read leaves it not knowing which model would answer: that is its own
	// state, with its own advice, and no generation is asked for.
	it.each([
		['a list above its bound', 'oversized'],
		['a body that is not JSON', 'not json'],
		['a digest that is not 64 hex characters', 'bad digest']
	])('refuses to generate when the model list is unreadable: %s', async (_label, kind) => {
		let host!: FakeHost;
		const tagsRoute: Route =
			kind === 'oversized'
				? (_req, res) =>
						streamHostileJson(
							res,
							HOSTILE_BYTES,
							counterFor(() => host, '/api/tags'),
							false
						)
				: kind === 'not json'
					? (_req, res) => {
							res.writeHead(200).end('<html>proxy error</html>');
						}
					: tags(tagsBody([{ name: MODEL, digest: 'abc123' }]));
		host = await fakeHost({
			'/api/version': version,
			'/api/tags': tagsRoute,
			'/api/chat': chat(answer)
		});
		const result = await requestLocalModel(stringRequest(10), envFor(host));
		expect(result).toEqual({
			unavailable: true,
			failureCode: 'model_unidentified',
			notCharged: true
		});
		expect(host.hits['/api/chat'] ?? 0).toBe(0);
		expect(host.bytesAccepted['/api/tags'] ?? 0).toBeLessThan(READ_MARGIN);
	});
});

describe('BP_LLM_MODEL_DIGEST at boot (#967)', () => {
	// Through the collector, so the refusal is read as it reaches the operator's report, which keeps
	// a check's message only when it was thrown as an OperatorFacingError (#816).
	async function reportFor(value: string | undefined) {
		const { assertLlmModelDigestConfigured } = await import('./local-llm');
		const { collectEnvironmentProblems } = await import('$lib/server/env/assertConfigured');
		const previous = process.env.BP_LLM_MODEL_DIGEST;
		if (value === undefined) delete process.env.BP_LLM_MODEL_DIGEST;
		else process.env.BP_LLM_MODEL_DIGEST = value;
		try {
			return await collectEnvironmentProblems([
				['BP_LLM_MODEL_DIGEST', assertLlmModelDigestConfigured]
			]);
		} finally {
			if (previous === undefined) delete process.env.BP_LLM_MODEL_DIGEST;
			else process.env.BP_LLM_MODEL_DIGEST = previous;
		}
	}

	// Separates a pin that is checked from one that is read as typed: a value that can never equal a
	// digest Ollama reports would refuse every generation, so it is refused where the operator reads.
	it.each([
		['a short ID, as `ollama list` prints it', DIGEST.slice(0, 12)],
		['the sha256: prefix', `sha256:${DIGEST}`],
		['upper case', DIGEST.toUpperCase()],
		['a trailing space', `${DIGEST} `]
	])('refuses %s, naming the variable and the shape', async (_label, value) => {
		expect(await reportFor(value)).toEqual([
			expect.stringMatching(/^BP_LLM_MODEL_DIGEST .*64 lowercase hexadecimal characters/)
		]);
	});

	it.each([
		['unset', undefined],
		['empty, as an .env line with no value', ''],
		['a full digest', DIGEST]
	])('accepts %s', async (_label, value) => {
		expect(await reportFor(value)).toEqual([]);
	});
});

/**
 * The contradiction pass on the design note (2026-10-12), one test per finding taken. Each names the
 * two states it separates.
 */
describe('model host edges found before coding (#967)', () => {
	const answer = JSON.stringify({ text: 'ok' });

	// Ollama's `-cloud` tags forward the chat to ollama.com while LLM_BASE_URL stays on loopback.
	// Measured on 0.32.5: the entry carries `remote_host` and `remote_model`. Separates a transport
	// that sends member data to a host no allowlist names from one that refuses before generating.
	it('refuses a model the host forwards to another machine, before generating', async () => {
		const cloud = JSON.stringify({
			models: [
				{
					name: MODEL,
					model: MODEL,
					remote_model: 'gpt-oss:20b',
					remote_host: 'https://ollama.com',
					modified_at: '2026-10-12T10:00:00Z',
					size: 306,
					digest: DIGEST,
					details: { parent_model: '', format: '', family: '' }
				}
			]
		});
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(cloud),
			'/api/chat': chat(answer)
		});
		const result = await requestLocalModel(stringRequest(10), envFor(host));
		expect(result).toEqual({ unavailable: true, failureCode: 'model_remote', notCharged: true });
		expect(host.hits['/api/chat'] ?? 0).toBe(0);
	});

	// The model list loads no model, so a list that never comes is a host that is not answering,
	// not a cold start. Separates the connect budget's reading from the generation budget's.
	it('reads a model list that never comes as unreachable, within the connect budget', async () => {
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': () => undefined,
			'/api/chat': chat(answer)
		});
		const startedAt = Date.now();
		const result = await requestLocalModel(
			stringRequest(10),
			envFor(host, { LLM_CONNECT_TIMEOUT_MS: '100', LLM_TIMEOUT_MS: '30000' })
		);
		expect(result).toEqual({ unavailable: true, failureCode: 'unreachable', notCharged: true });
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	// A format the transport cannot bound is refused before any socket opens, not after the probe.
	it('refuses an unbounded format before contacting the host at all', async () => {
		const host = await fakeHost({ '/api/version': version, '/api/tags': tags() });
		const request = {
			...stringRequest(10),
			format: { type: 'object', properties: { text: { type: 'string' } } }
		};
		await expect(requestLocalModel(request, envFor(host))).rejects.toThrow(/maxLength or enum/);
		expect(host.hits).toEqual({});
	});

	// The client swallows a body error on a non-2xx status and reports only the status, so an
	// oversized 404 used to read as « model not pulled ». Separates the bound's reading from the
	// status's.
	it('names an oversized error answer as unusable, not as the status it carried', async () => {
		let host!: FakeHost;
		host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(),
			'/api/chat': (_req, res) => {
				res.statusCode = 404;
				return streamHostileJson(
					res,
					HOSTILE_BYTES,
					counterFor(() => host, '/api/chat'),
					false
				);
			}
		});
		const result = await requestLocalModel(stringRequest(10), envFor(host));
		expect(result).toEqual({ unavailable: true, failureCode: 'response_unusable' });
		expect(host.bytesAccepted['/api/chat'] ?? 0).toBeLessThan(READ_MARGIN);
	});

	// llama.cpp's grammar lets an honest model put up to 22 whitespace characters in every slot
	// (`| " " | "\n"{1,2} [ \t]{0,20}`, the only space rule in the 0.32.5 image). Separates a bound
	// that counts those slots from one sized for compact JSON. The serialiser below writes the
	// grammar's slots exactly (after `{`, `[`, `:`, `,`, every key, and every value), each filled.
	it('reads an honest answer at the schema maximum with every whitespace slot filled', async () => {
		const W = '\n\n' + '\t'.repeat(20);
		const str = (s: string) => `${JSON.stringify(s)}${W}`;
		const obj = (entries: [string, string][]) =>
			`{${W}${entries.map(([k, v]) => `${str(k)}:${W}${v}`).join(`,${W}`)}}${W}`;
		const arr = (items: string[]) => `[${W}${items.join(`,${W}`)}]${W}`;
		const pick = obj([
			['kind', str('<'.repeat(12))],
			['category', str('<'.repeat(12))]
		]);
		// Forty items, so the slots outweigh the envelope's slack: with no allowance for them, this
		// answer exceeds the bound, which is what makes the test able to fail.
		const content = obj([['picks', arr(Array.from({ length: 40 }, () => pick))]]);
		const request: LocalModelRequest<unknown> = {
			prompt: 'p',
			format: {
				type: 'object',
				properties: {
					picks: {
						type: 'array',
						maxItems: 40,
						items: {
							type: 'object',
							properties: {
								kind: { type: 'string', maxLength: 12 },
								category: { type: 'string', maxLength: 12 }
							}
						}
					}
				}
			},
			schema: z.unknown(),
			numPredict: 64
		};
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(),
			'/api/chat': chat(content)
		});
		const result = await requestLocalModel(request, envFor(host));
		expect(result?.unavailable).toBeUndefined();
		expect(result?.value).toEqual(JSON.parse(content));
	});

	// Ollama shortens a name the way its own `ollama list` prints it: the default registry and the
	// `library` namespace dropped, `:latest` added when the last path segment has no tag. Separates a
	// match on Ollama's reading of the name from a match on its spelling.
	it.each([
		['library/qwen2.5:0.5b', 'qwen2.5:0.5b'],
		['registry.ollama.ai/library/qwen2.5:0.5b', 'qwen2.5:0.5b'],
		['localhost:5000/team/model', 'localhost:5000/team/model:latest'],
		['team/model', 'team/model:latest']
	])('finds %s listed as %s', async (configured, listed) => {
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(tagsBody([{ name: listed, digest: DIGEST }])),
			'/api/chat': chat(answer)
		});
		const result = await requestLocalModel(
			stringRequest(10),
			envFor(host, { LLM_MODEL: configured })
		);
		expect(result).toEqual({ value: { text: 'ok' }, model: { digest: DIGEST, format: 'gguf' } });
	});

	// A pull finishing between the list read and the generation runs the new weights under the old
	// record. Separates a digest checked once from one confirmed after the answer.
	it('refuses an answer when the model changed during the generation', async () => {
		let reads = 0;
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': (_req, res) => {
				reads += 1;
				const digest = reads === 1 ? DIGEST : 'e'.repeat(64);
				res.writeHead(200).end(tagsBody([{ name: MODEL, digest }]));
			},
			'/api/chat': chat(answer)
		});
		const result = await requestLocalModel(stringRequest(10), envFor(host));
		expect(result).toEqual({ unavailable: true, failureCode: 'model_mismatch' });
		expect(host.hits['/api/chat']).toBe(1);
	});
});
