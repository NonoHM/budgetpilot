import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

/**
 * A model host on a real loopback socket, for the specs that measure what the transport reads and
 * when it stops (#967, #986). A real server rather than a `fetch` spy, because what these specs
 * assert is what crossed a socket: bytes pulled off the wire, and a connection the client closed.
 *
 * Every host a spec opens is closed by `closeFakeHosts`, which the spec registers in `afterEach`.
 */

/** The digest `/api/tags` reports for the model the fake host serves. 64 hex, as Ollama prints it. */
export const DIGEST = 'a8b0c51577010a738c3a6f8f2d5e3a1f4c1e0b9d8a7f6e5d4c3b2a1908172635';
export const MODEL = 'qwen2.5:0.5b';

export type Route = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface FakeHost {
	baseUrl: string;
	/** Body bytes the server managed to hand to the socket, per path. */
	bytesAccepted: Record<string, number>;
	/** How many requests reached each path. */
	hits: Record<string, number>;
	close: () => Promise<void>;
}

const hosts: FakeHost[] = [];
export async function closeFakeHosts(): Promise<void> {
	await Promise.all(hosts.splice(0).map((host) => host.close()));
}

export function tagsBody(entries: { name: string; digest: string; format?: string }[]) {
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
export function chatBody(content: string) {
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
export function goJson(value: unknown) {
	return JSON.stringify(value)
		.replaceAll('<', '\\u003c')
		.replaceAll('>', '\\u003e')
		.replaceAll('&', '\\u0026');
}

/** Writes `total` bytes of a JSON string body, honouring backpressure, and counts what was taken. */

export async function fakeHost(routes: Record<string, Route>): Promise<FakeHost> {
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

export const version: Route = (_req, res) => {
	res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"version":"0.32.5"}');
};
export const tags =
	(body = tagsBody([{ name: MODEL, digest: DIGEST }])): Route =>
	(_req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
	};
export const chat =
	(content: string): Route =>
	(_req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' }).end(chatBody(content));
	};

export function envFor(host: FakeHost, extra: Record<string, string> = {}) {
	return {
		LLM_ENABLED: 'true',
		LLM_PROVIDER: 'ollama',
		LLM_BASE_URL: host.baseUrl,
		LLM_MODEL: MODEL,
		...extra
	};
}

/** A caller's request: one string of at most `maxLength` characters. Shaped as `LocalModelRequest`, unimported: the model door (#535) admits no importer outside a spec. */
export function stringRequest(maxLength: number) {
	return {
		prompt: 'p',
		format: {
			type: 'object',
			properties: { text: { type: 'string', maxLength } },
			required: ['text']
		} as const,
		// Deliberately looser than the format: the bound under test is the transport's, so the
		// caller's own validation must not be what refuses.
		schema: z.object({ text: z.string() }),
		numPredict: 64
	};
}
