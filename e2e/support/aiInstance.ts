import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
	expect,
	request as apiRequest,
	type APIRequestContext,
	type Browser,
	type Page
} from '@playwright/test';
import * as m from '../../src/lib/paraglide/messages';
import type { SeedTransaction } from '../../src/lib/server/ai/qualification/corpus';

/**
 * One BudgetPilot BUILD on its own port and its own SQLite file, for the suites that need
 * `LLM_ENABLED=true` and members the shared e2e database may not have (#971). The model address is
 * the caller's: a scripted model in `ai-qualification.spec.ts`, a recording proxy in front of a real
 * Ollama in `ai-check/`.
 *
 * Members are registered by the first member, signed in, which is the route a household uses in
 * `admin_only` mode, and seeded through the dashboard's own form action. Nothing here writes to the
 * database directly, so a fixture reaches the prompt by the same path a person's data does.
 */

export const MEMBER_PASSWORD = 'AiQualificationPassw0rd-971!';

export interface AiInstance {
	baseUrl: string;
	bootstrapToken: string;
	log(): string;
	stop(): void;
}

export async function bootAiInstance(options: {
	name: string;
	port: number;
	llmBaseUrl: string;
	env?: Record<string, string>;
}): Promise<AiInstance> {
	if (!existsSync('build/index.js')) {
		throw new Error(`${options.name}: build/index.js is absent, so there is no artifact to boot`);
	}
	const dir = path.resolve(`e2e/.data/${options.name}`);
	const databaseUrl = `file:./e2e/.data/${options.name}/ai.sqlite`;
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
		env: { ...process.env, DATABASE_PROVIDER: 'sqlite', DATABASE_URL: databaseUrl },
		stdio: 'ignore'
	});
	const baseUrl = `http://localhost:${options.port}`;
	const bootstrapToken = `${options.name}-bootstrap-token-5f1c`;
	const server: ChildProcessByStdio<null, Readable, Readable> = spawn('node', ['build/index.js'], {
		env: {
			...process.env,
			NODE_ENV: 'production',
			DATABASE_PROVIDER: 'sqlite',
			DATABASE_URL: databaseUrl,
			PORT: String(options.port),
			ORIGIN: baseUrl,
			PUBLIC_INSTANCE: 'false',
			REGISTRATION_MODE: 'admin_only',
			PASSWORD_HASH_COST: '12',
			BOOTSTRAP_TOKEN: bootstrapToken,
			RATE_LIMIT_HASH_SECRET: 'beef'.repeat(16),
			TOTP_ENCRYPTION_KEY: 'face'.repeat(16),
			BANK_SYNC_ENABLED: 'false',
			LLM_ENABLED: 'true',
			LLM_BASE_URL: options.llmBaseUrl,
			...options.env
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let captured = '';
	server.stdout.on('data', (chunk: Buffer) => (captured += chunk.toString()));
	server.stderr.on('data', (chunk: Buffer) => (captured += chunk.toString()));
	const started = Date.now();
	let up = false;
	while (!up && Date.now() - started < 30_000) {
		up = await fetch(`${baseUrl}/login`).then(
			(response) => response.ok,
			() => false
		);
		if (!up) await new Promise((resolve) => setTimeout(resolve, 100));
	}
	if (!up) {
		server.kill('SIGKILL');
		throw new Error(`${options.name}: server never became reachable\n${captured}`);
	}
	return {
		baseUrl,
		bootstrapToken,
		log: () => captured,
		stop() {
			server.kill('SIGTERM');
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

async function api(baseUrl: string): Promise<APIRequestContext> {
	return apiRequest.newContext({
		baseURL: baseUrl,
		storageState: { cookies: [], origins: [] },
		extraHTTPHeaders: { Origin: baseUrl, Accept: 'application/json', 'Accept-Language': 'en-US' }
	});
}

/** The form actions answer `{ type }` as JSON when asked for it; anything but `want` is a failed seed. */
async function expectAction(
	response: Awaited<ReturnType<APIRequestContext['post']>>,
	want: string,
	what: string
): Promise<void> {
	const body = (await response.json().catch(() => ({}))) as { type?: string };
	expect(body.type, what).toBe(want);
}

export async function registerMembers(instance: AiInstance, emails: string[]): Promise<void> {
	const client = await api(instance.baseUrl);
	for (const [index, email] of emails.entries()) {
		const registered = await client.post('/register', {
			form: {
				email,
				password: MEMBER_PASSWORD,
				...(index === 0 ? { bootstrapToken: instance.bootstrapToken } : {})
			},
			maxRedirects: 0
		});
		await expectAction(registered, index === 0 ? 'redirect' : 'success', `${email} registered`);
		if (index === 0) {
			await client.post('/logout', { maxRedirects: 0 }).catch(() => undefined);
			const signedIn = await client.post('/login', {
				form: { email, password: MEMBER_PASSWORD },
				maxRedirects: 0
			});
			await expectAction(signedIn, 'redirect', 'the first member signed in');
		}
	}
	await client.dispose();
}

export interface SeededMember {
	email: string;
	storageState: Awaited<ReturnType<APIRequestContext['storageState']>>;
}

/**
 * Signs `email` in and writes `transactions` dated today (UTC, the server's own day), so they fall
 * in the dashboard's default period. A seed that crosses midnight UTC lands in two months; the
 * window is the seconds between the first write and the press, and the run says which day it used.
 */
export async function seedMember(
	instance: AiInstance,
	email: string,
	transactions: SeedTransaction[],
	options: { includeLabels?: boolean } = {}
): Promise<SeededMember> {
	const client = await api(instance.baseUrl);
	const signedIn = await client.post('/login', {
		form: { email, password: MEMBER_PASSWORD },
		maxRedirects: 0
	});
	await expectAction(signedIn, 'redirect', `${email} signed in`);
	const today = new Date().toISOString().slice(0, 10);
	for (const transaction of transactions) {
		const written = await client.post('/?/createTransaction', {
			form: { date: today, ...transaction }
		});
		await expectAction(written, 'success', `${email} wrote « ${transaction.label} »`);
	}
	if (options.includeLabels) {
		const labels = await client.post('/settings?/updateAiIncludeLabels', {
			form: { enabled: 'true' }
		});
		await expectAction(labels, 'success', `${email} turned labels on`);
	}
	const storageState = await client.storageState();
	await client.dispose();
	return { email, storageState };
}

export interface AdviceAnswer {
	/** What `/insights/advice` returned: the app's verdict, after every check it applies. */
	json: {
		insights: {
			title: string;
			message: string;
			severity: 'info' | 'warning' | 'critical';
			category: string;
		}[];
		unavailable: boolean;
		failureCode?: string;
		cancelled?: true;
	};
	/** The advice region's visible text, whitespace collapsed; null when the card shows no advice. */
	adviceText: string | null;
	page: Page;
}

/**
 * The journey a member takes: open the dashboard, press the AI card, read what the server answered
 * and what the card shows. The page is returned open so a caller can inspect the DOM; the caller
 * closes its context.
 *
 * The press is repeated only while the card has not reported itself open, so a press lost to
 * hydration is retried and a press that landed is never doubled (it would spend an analysis).
 */
export async function askAdvice(
	browser: Browser,
	instance: AiInstance,
	member: SeededMember,
	options: { timeoutMs?: number } = {}
): Promise<AdviceAnswer> {
	const context = await browser.newContext({
		baseURL: instance.baseUrl,
		storageState: member.storageState,
		locale: 'en-US'
	});
	const page = await context.newPage();
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	const card = page
		.getByRole('button', {
			name: m.dashboard_insights_ai_badge({}, { locale: 'en' }),
			exact: false
		})
		.first();
	const answered = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === '/insights/advice' &&
			response.request().method() === 'POST',
		{ timeout: options.timeoutMs ?? 30_000 }
	);
	await expect(async () => {
		if ((await card.getAttribute('aria-expanded')) !== 'true') await card.click();
		await expect(card).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 });
	}).toPass({ timeout: 15_000 });
	const response = await answered;
	const json = (await response.json()) as AdviceAnswer['json'];
	const advice = page.locator('#dashboard-ai-advice-content');
	let adviceText: string | null = null;
	if (!json.unavailable && json.insights.length > 0) {
		await expect(advice).toBeVisible();
		adviceText = ((await advice.textContent()) ?? '').replace(/\s+/g, ' ').trim();
	}
	return { json, adviceText, page };
}
