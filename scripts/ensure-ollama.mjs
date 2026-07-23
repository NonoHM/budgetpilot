import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const baseUrl = (process.env.LLM_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
const model = process.env.LLM_MODEL ?? 'qwen2.5:0.5b';
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
	await execFileAsync('ollama', ['pull', model], { timeout: 120_000 });
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
