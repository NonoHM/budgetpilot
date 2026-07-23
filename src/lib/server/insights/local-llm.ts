import { Ollama } from 'ollama';
import { parseHostsCsv } from '$lib/server/hosts';
import { localLlmJsonSchema, localLlmResponseSchema } from './schema';
import type { BudgetInsight, LocalLlmResult } from './types';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5:0.5b';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
// host.docker.internal refers to the host machine itself from inside a Docker container:
// it isn't a remote server, so http: remains acceptable (Ollama doesn't serve TLS there).
const DEFAULT_HTTP_PERMITTED_HOSTS = [...DEFAULT_ALLOWED_HOSTS, 'host.docker.internal'];

export function isLocalLlmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.LLM_ENABLED === 'true' && (env.LLM_PROVIDER ?? 'ollama') === 'ollama';
}

export async function requestLocalBudgetInsights(
	prompt: string,
	env: NodeJS.ProcessEnv = process.env
): Promise<LocalLlmResult | null> {
	if (!isLocalLlmEnabled(env)) return null;

	const baseUrl = getLocalBaseUrl(env.LLM_BASE_URL ?? DEFAULT_BASE_URL, env);
	if (!baseUrl) return { summary: '', insights: [], unavailable: true };

	const model = env.LLM_MODEL ?? DEFAULT_MODEL;
	const timeoutMs = parsePositiveInt(env.LLM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

	const client = new Ollama({
		host: baseUrl,
		fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) })
	});

	try {
		const response = await client.chat({
			model,
			messages: [{ role: 'user', content: prompt }],
			format: localLlmJsonSchema,
			options: {
				temperature: 0.2,
				num_predict: 512
			}
		});

		const content = response.message?.content;
		if (!content) return { summary: '', insights: [], unavailable: true };

		return parseLocalLlmContent(content);
	} catch {
		return { summary: '', insights: [], unavailable: true };
	}
}

function parseLocalLlmContent(content: string): LocalLlmResult {
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(content);
	} catch {
		return { summary: '', insights: [], unavailable: true };
	}

	const parsed = localLlmResponseSchema.safeParse(parsedJson);
	if (!parsed.success) return { summary: '', insights: [], unavailable: true };

	const insights: BudgetInsight[] = parsed.data.insights.map((item, index) => ({
		id: `local-llm-${index + 1}`,
		title: item.title,
		message: item.message,
		severity: item.severity,
		category: item.category,
		source: 'local-llm'
	}));

	return { summary: parsed.data.summary, insights };
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
