import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MODEL_LIST_MAX_BYTES } from './local-llm';

/**
 * #994 items 6 and 8: `scripts/ensure-ollama.mjs`, which `npm run dev:ai` and `npm run setup:llm`
 * run against the operator's own Ollama. It runs here as a child `node`, as those commands run it,
 * against a fake Ollama on an ephemeral port and a fake `ollama` command that is the only thing on
 * its PATH, so no real Ollama is ever reached or pulled from.
 */

const SCRIPT = resolve(import.meta.dirname, '../../../../scripts/ensure-ollama.mjs');
const MODEL = 'fake-model:1b';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serve(handler: Handler): Promise<{ url: string; hits: () => number }> {
	let hits = 0;
	const server: Server = createServer((request, response) => {
		hits += 1;
		handler(request, response);
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	cleanups.push(
		() =>
			new Promise<void>((done) => {
				server.closeAllConnections();
				server.close(() => done());
			})
	);
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}`, hits: () => hits };
}

/**
 * A fake `ollama`: `--version` succeeds, `pull` exits 0. With `failSpawnAfterVersion`, it removes its
 * own execute bit after answering `--version`, so the later `spawn('ollama', ['pull'])` fails to
 * START (EACCES) and emits `error` rather than `exit`: the case #994 item 6 names.
 */
function fakeOllamaDir(failSpawnAfterVersion = false): string {
	const dir = mkdtempSync(join(tmpdir(), 'ensure-ollama-'));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const self = join(dir, 'ollama');
	writeFileSync(
		self,
		[
			'#!/bin/sh',
			'if [ "$1" = "--version" ]; then',
			failSpawnAfterVersion ? `  /bin/chmod -x "${self}"` : '  :',
			'  echo "ollama version is 0.0.0"',
			'  exit 0',
			'fi',
			'exit 0',
			''
		].join('\n')
	);
	chmodSync(self, 0o755);
	return dir;
}

function run(baseUrl: string, pathDir: string, args: string[] = []) {
	return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
		const child = spawn(process.execPath, [SCRIPT, ...args], {
			env: { PATH: pathDir, LLM_BASE_URL: baseUrl, LLM_MODEL: MODEL },
			timeout: 20_000
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		child.on('close', (status) => done({ status, stdout, stderr }));
	});
}

/** A `/api/tags` body listing MODEL, padded with spaces to exactly `bytes` bytes (valid JSON). */
function listOfLength(bytes: number): string {
	const json = JSON.stringify({ models: [{ name: MODEL }] });
	expect(bytes).toBeGreaterThanOrEqual(json.length);
	return json + ' '.repeat(bytes - json.length);
}

function answer(body: string): Handler {
	return (_request, response) => {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(body);
	};
}

describe('ensure-ollama.mjs against a fake model host', () => {
	it('reports the model present when the host lists it (the positive every other case is read against)', async () => {
		const host = await serve(answer(JSON.stringify({ models: [{ name: MODEL }] })));
		const result = await run(host.url, fakeOllamaDir());
		expect(result.stdout).toBe(`Modèle Ollama disponible : ${MODEL}\n`);
		expect(result.status).toBe(0);
	});

	// Separates « follows the redirect » (the canary is read and the model reads as present) from
	// « refuses it » (the canary is never reached and the line names the redirect).
	it('follows no redirect from the model host, and says that is why it stopped', async () => {
		const canary = await serve(answer(JSON.stringify({ models: [{ name: MODEL }] })));
		const host = await serve((_request, response) => {
			response.writeHead(302, { location: `${canary.url}/api/tags` });
			response.end();
		});
		// The canary answers a direct request in the same run, so a zero below is about the script.
		expect((await fetch(`${canary.url}/api/tags`)).status).toBe(200);
		expect(canary.hits()).toBe(1);

		const result = await run(host.url, fakeOllamaDir());

		expect(host.hits()).toBeGreaterThanOrEqual(1);
		expect(canary.hits()).toBe(1);
		expect(result.stdout).toBe(
			`Ollama sur ${host.url} répond par une redirection (HTTP 302), que ce script ne suit pas. Vérifie LLM_BASE_URL.\n`
		);
		expect(result.status).toBe(0);
	});

	// The boundary is the app's own constant, so a script copy that drifts from it reddens one side.
	it('reads a model list of exactly the cap', async () => {
		const host = await serve(answer(listOfLength(MODEL_LIST_MAX_BYTES)));
		const result = await run(host.url, fakeOllamaDir());
		expect(result.stdout).toBe(`Modèle Ollama disponible : ${MODEL}\n`);
	});

	// Separates « read whole » (the model at the head of an oversized list reads as present) from
	// « capped » (refused, and never reported as « absent », which with --pull would start a download).
	it('refuses a model list one byte over the cap, and does not report the model absent', async () => {
		const host = await serve(answer(listOfLength(MODEL_LIST_MAX_BYTES + 1)));
		const result = await run(host.url, fakeOllamaDir(), ['--pull']);
		expect(result.stdout).toBe(
			`La liste des modèles d'Ollama sur ${host.url} dépasse ${MODEL_LIST_MAX_BYTES} octets : ce script ne la lit pas. Vérifie le modèle avec "ollama list".\n`
		);
		expect(result.status).toBe(0);
	});

	// Separates a STREAMING cap from a `Content-Length` check (no length is sent here, so it reads
	// whole) and from a read-whole-then-measure (which never ends, and the 3 s budget cuts it as
	// unreadable): only a count that stops the stream at the cap prints the over-cap line.
	it('stops reading an endless chunked list at the cap', async () => {
		const host = await serve((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.write('{"models":[');
			const chunk = `{"name":"x"},`.repeat(4096);
			const pump = () => {
				while (!response.destroyed && response.write(chunk));
				if (!response.destroyed) response.once('drain', pump);
			};
			pump();
		});
		const result = await run(host.url, fakeOllamaDir(), ['--pull']);
		expect(result.stdout).toBe(
			`La liste des modèles d'Ollama sur ${host.url} dépasse ${MODEL_LIST_MAX_BYTES} octets : ce script ne la lit pas. Vérifie le modèle avec "ollama list".\n`
		);
	});

	// Each of these is a host that ANSWERED: before, all three printed « Modèle absent » and, under
	// --pull, started the download. Separates « unreadable, pull nothing » from « absent, pull ».
	const UNREADABLE = (url: string) =>
		`Ollama sur ${url} a répondu, mais sa liste des modèles est illisible : ce script ne télécharge rien. Vérifie le modèle avec "ollama list".\n`;

	it('pulls nothing when the list is not JSON', async () => {
		const host = await serve(answer('{"models": ['));
		const result = await run(host.url, fakeOllamaDir(), ['--pull']);
		expect(result.stdout).toBe(UNREADABLE(host.url));
	});

	it('pulls nothing when the list has no models array', async () => {
		const host = await serve(answer(JSON.stringify({ models: { name: MODEL } })));
		const result = await run(host.url, fakeOllamaDir(), ['--pull']);
		expect(result.stdout).toBe(UNREADABLE(host.url));
	});

	// The app's schema refuses the WHOLE list when one entry has no string `name` (`modelListSchema`
	// in local-llm.ts), so the script may not read the remaining entries as a list lacking the model.
	it('pulls nothing when an entry carries no name', async () => {
		const host = await serve(answer(JSON.stringify({ models: [{ name: 'other:1b' }, {}] })));
		const result = await run(host.url, fakeOllamaDir(), ['--pull']);
		expect(result.stdout).toBe(UNREADABLE(host.url));
	});

	// Waits out the script's 3 s budget, so it carries its own timeout above vitest's 5 s default.
	it('pulls nothing when the list stalls past the time budget', { timeout: 15_000 }, async () => {
		const host = await serve((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.write('{"models":[');
		});
		const result = await run(host.url, fakeOllamaDir(), ['--pull']);
		expect(result.stdout).toBe(UNREADABLE(host.url));
	});

	// Separates « did not answer » from « answered with an error status », which named the wrong fix.
	it('names the status of a host that answered with an error', async () => {
		const host = await serve((_request, response) => {
			response.writeHead(500);
			response.end();
		});
		const result = await run(host.url, fakeOllamaDir(), ['--pull']);
		expect(result.stdout).toBe(`Ollama sur ${host.url} répond HTTP 500. Vérifie LLM_BASE_URL.\n`);
	});

	// Separates « no error listener » (the unhandled `error` event kills the process with a stack) from
	// « listened » (the operator gets the friendly line and the dev server still starts after it).
	it('reports a pull that cannot start with the friendly line, not a crash', async () => {
		const host = await serve(answer(JSON.stringify({ models: [] })));
		const result = await run(host.url, fakeOllamaDir(true), ['--pull']);
		expect(result.stdout).toBe(
			`Téléchargement du modèle Ollama : ${MODEL}\n` +
				`Impossible de télécharger ${MODEL}. Vérifie Ollama puis relance "ollama pull ${MODEL}".\n`
		);
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
	});

	it('still reports a refused connection as no answer', async () => {
		const host = await serve(answer('{}'));
		await cleanups.pop()!();
		const result = await run(host.url, fakeOllamaDir());
		expect(result.stdout).toBe(
			`Ollama ne répond pas sur ${host.url}. Lance "ollama serve" puis relance si besoin.\n`
		);
	});
});
