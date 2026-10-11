import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { expect, request as apiRequest, type APIRequestContext } from '@playwright/test';

/**
 * One BudgetPilot BUILD on its own port and its own SQLite file, for a suite whose members or rows
 * the shared e2e database must not carry: rows dated in the real clock's month, a member another
 * spec would count. Nothing reaches the suite's database, and nothing here writes to this one
 * directly: members register through `/register` and seed through form actions, so a fixture
 * reaches the screen by the same path a person's data does.
 *
 * Extracted from the AI suites' helper when they were removed (#1010), without their model address.
 */

export const OWNER_PASSWORD = 'OwnInstancePassw0rd-1010!';

export interface OwnInstance {
	baseUrl: string;
	bootstrapToken: string;
	log(): string;
	/** Resolves once the server has exited, so the port is free for the next boot. */
	stop(): Promise<void>;
}

export async function bootOwnInstance(options: {
	name: string;
	port: number;
	env?: Record<string, string>;
}): Promise<OwnInstance> {
	if (!existsSync('build/index.js')) {
		throw new Error(`${options.name}: build/index.js is absent, so there is no artifact to boot`);
	}
	const dir = path.resolve(`e2e/.data/${options.name}`);
	const databaseUrl = `file:./e2e/.data/${options.name}/own.sqlite`;
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
		env: { ...process.env, DATABASE_PROVIDER: 'sqlite', DATABASE_URL: databaseUrl },
		stdio: 'ignore'
	});
	const baseUrl = `http://localhost:${options.port}`;
	const bootstrapToken = `${options.name}-bootstrap-token-1010`;
	const server: ChildProcessByStdio<null, Readable, Readable> = spawn('node', ['build/index.js'], {
		env: {
			...process.env,
			NODE_ENV: 'production',
			DATABASE_PROVIDER: 'sqlite',
			DATABASE_URL: databaseUrl,
			PORT: String(options.port),
			// Without it adapter-node guesses the public URL and the CSRF check refuses every form POST.
			ORIGIN: baseUrl,
			PUBLIC_INSTANCE: 'false',
			REGISTRATION_MODE: 'admin_only',
			PASSWORD_HASH_COST: '12',
			BOOTSTRAP_TOKEN: bootstrapToken,
			RATE_LIMIT_HASH_SECRET: 'beef'.repeat(16),
			TOTP_ENCRYPTION_KEY: 'face'.repeat(16),
			BANK_SYNC_ENABLED: 'false',
			LLM_ENABLED: 'false',
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
		async stop() {
			if (server.exitCode === null && server.signalCode === null) {
				const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
				server.kill('SIGTERM');
				await exited;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

/** A JSON-speaking client with no cookies: the form actions then answer `{ type }`. */
export async function ownClient(instance: OwnInstance): Promise<APIRequestContext> {
	return apiRequest.newContext({
		baseURL: instance.baseUrl,
		storageState: { cookies: [], origins: [] },
		extraHTTPHeaders: {
			Origin: instance.baseUrl,
			Accept: 'application/json',
			'Accept-Language': 'en-US'
		}
	});
}

/** A form action's answer is `{ type }`; anything but `want` is a failed step, named by `what`. */
export async function expectAction(
	response: Awaited<ReturnType<APIRequestContext['post']>>,
	want: string,
	what: string
): Promise<void> {
	const body = (await response.json().catch(() => ({}))) as { type?: string };
	expect(body.type, what).toBe(want);
}

/**
 * Registers the instance's first member with its bootstrap token, signs them in, and returns the
 * signed-in client. The caller disposes of it.
 */
export async function registerOwner(
	instance: OwnInstance,
	email: string
): Promise<APIRequestContext> {
	const client = await ownClient(instance);
	const registered = await client.post('/register', {
		form: { email, password: OWNER_PASSWORD, bootstrapToken: instance.bootstrapToken },
		maxRedirects: 0
	});
	await expectAction(registered, 'redirect', `${email} registered`);
	await client.post('/logout', { maxRedirects: 0 }).catch(() => undefined);
	const signedIn = await client.post('/login', {
		form: { email, password: OWNER_PASSWORD },
		maxRedirects: 0
	});
	await expectAction(signedIn, 'redirect', `${email} signed in`);
	return client;
}
