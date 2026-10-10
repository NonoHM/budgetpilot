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

const ollamaAvailable = await hasOllamaCommand();
if (!ollamaAvailable) {
	console.log(
		'Ollama introuvable. Installe Ollama depuis https://ollama.com puis relance ce script.'
	);
	process.exit(0);
}

const serverAvailable = await hasOllamaServer();
if (!serverAvailable) {
	console.log(`Ollama ne répond pas sur ${baseUrl}. Lance "ollama serve" puis relance si besoin.`);
	process.exit(0);
}

const modelAvailable = await hasModel(model);
if (modelAvailable) {
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
	await new Promise((resolve, reject) =>
		spawn('ollama', ['pull', model], { stdio: 'inherit' }).on('exit', (code) =>
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

async function hasOllamaServer() {
	try {
		const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3_000) });
		return response.ok;
	} catch {
		return false;
	}
}

async function hasModel(modelName) {
	try {
		const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3_000) });
		if (!response.ok) return false;

		const data = await response.json();
		return Array.isArray(data.models) && data.models.some((item) => item.name === modelName);
	} catch {
		return false;
	}
}
