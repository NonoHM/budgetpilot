import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
// The qualified default (#971), the same file the app reads.
const qualified = JSON.parse(
	readFileSync(
		new URL('../src/lib/server/ai/qualification/qualified-model.json', import.meta.url),
		'utf8'
	)
);
const baseUrl = (process.env.LLM_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
const model = process.env.LLM_MODEL ?? qualified.tag;
const shouldPull = process.argv.includes('--pull');
// The app's `MODEL_LIST_MAX_BYTES` (`src/lib/server/insights/local-llm.ts`), which this script cannot
// import; `ensureOllamaScript.spec.ts` tests the boundary at the app's value, so the copies cannot drift.
const MODEL_LIST_MAX_BYTES = 1024 * 1024;
// The redirect statuses `fetch` would follow (`src/lib/server/net/redirectGuard.ts`).
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const ollamaAvailable = await hasOllamaCommand();
if (!ollamaAvailable) {
	console.log(
		'Ollama introuvable. Installe Ollama depuis https://ollama.com puis relance ce script.'
	);
	process.exit(0);
}

const list = await readModelList();
if (list.kind === 'unreachable') {
	console.log(`Ollama ne répond pas sur ${baseUrl}. Lance "ollama serve" puis relance si besoin.`);
	process.exit(0);
}
if (list.kind === 'redirect') {
	console.log(
		`Ollama sur ${baseUrl} répond par une redirection (HTTP ${list.status}), que ce script ne suit pas. Vérifie LLM_BASE_URL.`
	);
	process.exit(0);
}
if (list.kind === 'status') {
	console.log(`Ollama sur ${baseUrl} répond HTTP ${list.status}. Vérifie LLM_BASE_URL.`);
	process.exit(0);
}
// Neither outcome below says the model is absent, so neither may start a 2.5 GB pull (#994).
if (list.kind === 'too-large') {
	console.log(
		`La liste des modèles d'Ollama sur ${baseUrl} dépasse ${MODEL_LIST_MAX_BYTES} octets : ce script ne la lit pas. Vérifie le modèle avec "ollama list".`
	);
	process.exit(0);
}
if (list.kind === 'unreadable') {
	console.log(
		`Ollama sur ${baseUrl} a répondu, mais sa liste des modèles est illisible : ce script ne télécharge rien. Vérifie le modèle avec "ollama list".`
	);
	process.exit(0);
}

if (list.names.includes(model)) {
	console.log(`Modèle Ollama disponible : ${model}`);
	process.exit(0);
}

if (!shouldPull) {
	console.log(`Modèle Ollama absent : ${model}. Lance "npm run setup:llm" pour le télécharger.`);
	process.exit(0);
}

console.log(`Téléchargement du modèle Ollama : ${model}`);
try {
	// Streamed, with no timeout: the qualified default is a 2.5 GB download (#971). A bound sized for
	// one link kills the pull on a slower one, and execFile's output buffer fills on the progress
	// lines. The operator asked for it with --pull, sees the progress, and can stop it.
	// `error` is a pull that never started (EACCES, ENOENT), which emits no `exit` (#994).
	await new Promise((resolve, reject) =>
		spawn('ollama', ['pull', model], { stdio: 'inherit' })
			.on('error', reject)
			.on('exit', (code) =>
				code === 0 ? resolve() : reject(new Error(`ollama pull exited with ${code}`))
			)
	);
	console.log(`Modèle Ollama prêt : ${model}`);
} catch {
	console.log(
		`Impossible de télécharger ${model}. Vérifie Ollama puis relance "ollama pull ${model}".`
	);
}

async function hasOllamaCommand() {
	try {
		await execFileAsync('ollama', ['--version'], { timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * The model list, read the way the app reads it since #967: no redirect followed, and the body
 * counted as it streams and dropped past `MODEL_LIST_MAX_BYTES`, whatever length the host declared.
 * The 3 s budget covers the body too, so a host that stalls mid-list is `unreadable`, not absent.
 */
async function readModelList() {
	const signal = AbortSignal.timeout(3_000);
	let response;
	try {
		response = await fetch(`${baseUrl}/api/tags`, { redirect: 'manual', signal });
	} catch {
		return { kind: 'unreachable' };
	}
	if (REDIRECT_STATUSES.has(response.status) || !response.ok) {
		await response.body?.cancel().catch(() => {});
		const kind = REDIRECT_STATUSES.has(response.status) ? 'redirect' : 'status';
		return { kind, status: response.status };
	}
	try {
		const chunks = [];
		let read = 0;
		if (response.body) {
			for await (const chunk of response.body) {
				read += chunk.byteLength;
				// Leaving the loop cancels the stream, so the socket stops at the cap.
				if (read > MODEL_LIST_MAX_BYTES) return { kind: 'too-large' };
				chunks.push(chunk);
			}
		}
		// A body that is not JSON, or whose `models` is not an array, throws into `unreadable`. One entry
		// without a string `name` makes the whole list unreadable, as the app's `modelListSchema` reads it.
		const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		const names = data.models.map((item) => item?.name);
		if (!names.every((name) => typeof name === 'string')) return { kind: 'unreadable' };
		return { kind: 'list', names };
	} catch {
		return { kind: 'unreadable' };
	}
}
