import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { request as apiRequest, type APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * #816: an unexpected error writes its class and code to the log, never its message or stack, on
 * the request path and on the boot path, against the SHIPPED artifact (`node build/index.js`).
 *
 * WHAT WAS MEASURED BEFORE THE FIX, which is what these assertions are chosen to separate. A
 * database error was forced by a trigger that refuses a write and quotes the row, standing in for an
 * engine message such as PostgreSQL's « Failing row contains (...) ».
 *
 *  - Boot path, SQLite: the transaction label carrying MARKER reached the log once, through the
 *    nested `meta.driverAdapterError.cause.originalMessage` that Node's printer walks.
 *  - Request path, PostgreSQL: the category name carrying MARKER reached the log once, in Prisma's
 *    message under SvelteKit's default printer. On SQLite the adapter replaces the database's text
 *    with « Foreign key constraint violated », so MARKER cannot appear here and its absence would
 *    prove nothing: the request test asserts on that message text and on stack frames instead, both
 *    present in the capture before the fix.
 *
 * A private server, port and database, for the reasons `log-secret-scan.spec.ts` gives: the suite's
 * own server is `vite preview`, whose output no spec can read, and the boot test must restart it.
 *
 * EVERY FAILURE IS FORCED ONCE, IN `beforeAll`, AND EACH TEST ASSERTS ONE FIGURE. The first version
 * ran the steps as serial tests: the red run against the code before the fix failed the request test
 * on its first assertion, so the absence of the message and of the stack below it were never
 * evaluated, and serial mode skipped the boot tests entirely. Captured up front, every figure is
 * evaluated whatever the others do.
 */

const PORT = 4179;
const BASE_URL = `http://localhost:${PORT}`;
const DB_DIR = path.resolve('e2e/.data/errorprinter');
const DB_FILE = path.join(DB_DIR, 'errorprinter.sqlite');
const DATABASE_URL = `file:./e2e/.data/errorprinter/errorprinter.sqlite`;
const MARKER = 'L0MRK7c41q';
const CONTROL_PATH = 'errorprinter-control-3e9a';
const EMAIL = 'errorprinter@budgetpilot.test';
const PASSWORD = 'ErrorPrinter-Passw0rd!';
const ERROR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SERVER_ENV = {
	DATABASE_URL,
	DATABASE_PROVIDER: 'sqlite',
	PORT: String(PORT),
	ORIGIN: BASE_URL,
	NODE_ENV: 'production',
	PUBLIC_INSTANCE: 'false',
	REGISTRATION_MODE: 'admin_only',
	PASSWORD_HASH_COST: '4',
	BOOTSTRAP_TOKEN: 'errorprinter-bootstrap-token-5b1c77',
	RATE_LIMIT_HASH_SECRET: 'beef'.repeat(16),
	TOTP_ENCRYPTION_KEY: 'feed'.repeat(16),
	LLM_ENABLED: 'false'
};

interface Server {
	process: ChildProcessByStdio<null, Readable, Readable>;
	captured: () => string;
	exited: Promise<number | null>;
}

function boot(override: Record<string, string> = {}): Server {
	let captured = '';
	const child = spawn('node', ['build/index.js'], {
		env: { ...process.env, ...SERVER_ENV, ...override },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	child.stdout.on('data', (chunk: Buffer) => (captured += chunk.toString()));
	child.stderr.on('data', (chunk: Buffer) => (captured += chunk.toString()));
	const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
	return { process: child, captured: () => captured, exited };
}

async function waitForServer(server: Server): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < 30_000) {
		try {
			if ((await fetch(`${BASE_URL}/login`)).ok) return;
		} catch {
			// Not accepting connections yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`error-printer: server never became reachable\n${server.captured()}`);
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

interface Forced {
	status: number;
	message: string | undefined;
	errorId: string;
}

/** Output of the server that served the requests, up to its stop. */
let requestCapture = '';
let actionFailure: Forced;
let pageFailure: { status: number; html: string };
let recomputeBoot: { exitCode: number | null; captured: string };
let refusedBoot: { exitCode: number | null; captured: string };

async function untilExit(server: Server): Promise<number | null> {
	const outcome = await Promise.race([
		server.exited,
		new Promise<'running'>((resolve) => setTimeout(() => resolve('running'), 30_000))
	]);
	if (outcome === 'running') {
		server.process.kill('SIGTERM');
		throw new Error(
			`error-printer: a boot that should have failed is still running\n${server.captured()}`
		);
	}
	return outcome;
}

function sql(statement: string): number {
	const db = new DatabaseSync(DB_FILE);
	try {
		return Number(db.prepare(statement).run().changes);
	} finally {
		db.close();
	}
}

test.beforeAll(async () => {
	if (!existsSync('build/index.js')) {
		throw new Error('error-printer: build/index.js is absent, so there is no artifact to boot');
	}
	rmSync(DB_DIR, { recursive: true, force: true });
	mkdirSync(DB_DIR, { recursive: true });
	execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
		env: { ...process.env, DATABASE_URL, DATABASE_PROVIDER: 'sqlite' },
		stdio: 'ignore'
	});

	const server = boot();
	let client: APIRequestContext | undefined;
	try {
		await waitForServer(server);
		client = await apiRequest.newContext({
			baseURL: BASE_URL,
			storageState: { cookies: [], origins: [] },
			extraHTTPHeaders: { Origin: BASE_URL, Accept: 'application/json' }
		});
		const api = client;
		const form = async (url: string, fields: Record<string, string>) =>
			(await (await api.post(url, { form: fields, maxRedirects: 0 })).json()) as { type: string };

		// Each seed step's outcome is checked, so a figure below cannot be blamed on a step that never
		// happened.
		const seeded = [
			(
				await form('/register', {
					email: EMAIL,
					password: PASSWORD,
					bootstrapToken: SERVER_ENV.BOOTSTRAP_TOKEN
				})
			).type,
			(await form('/login', { email: EMAIL, password: PASSWORD })).type,
			(
				await form('/?/createTransaction', {
					date: '2026-09-15',
					label: `Grocery ${MARKER}`,
					amount: '-12.34',
					category: 'Transport'
				})
			).type,
			String((await api.get(`/${CONTROL_PATH}`)).status())
		];
		if (seeded.join(',') !== 'redirect,redirect,success,404') {
			throw new Error(`error-printer: seeding did not complete (${seeded.join(',')})`);
		}

		// 1. An action whose write the database refuses, quoting the row.
		sql(`CREATE TRIGGER errorprinter_category BEFORE INSERT ON "Category"
			WHEN NEW.name LIKE '%${MARKER}%' BEGIN SELECT RAISE(ABORT, 'refused row ' || NEW.name); END`);
		const action = await api.post('/categories?/createCategory', {
			form: { name: `Food ${MARKER}` },
			maxRedirects: 0
		});
		const actionBody = (await action.json()) as { error?: { message?: string; errorId?: string } };
		actionFailure = {
			status: action.status(),
			message: actionBody.error?.message,
			errorId: actionBody.error?.errorId ?? ''
		};

		// 2. A page whose load fails: the table it reads is renamed away, then back.
		sql('ALTER TABLE "Category" RENAME TO "Category_errorprinter"');
		try {
			const page = await api.get('/categories', { headers: { Accept: 'text/html' } });
			pageFailure = { status: page.status(), html: await page.text() };
		} finally {
			sql('ALTER TABLE "Category_errorprinter" RENAME TO "Category"');
		}
		// The two error lines are written before the responses complete, but give the pipe a moment.
		await new Promise((resolve) => setTimeout(resolve, 300));
	} finally {
		await client?.dispose();
		server.process.kill('SIGTERM');
		await server.exited;
		requestCapture = server.captured();
	}

	// 3. A boot whose recompute write the database refuses, quoting the row: pending for the
	//    recompute means a key, a hash, and not the current version's prefix.
	const marked = sql(
		`UPDATE "Transaction" SET dedupeKey = 'legacy-' || id, dedupeKeyHash = 'legacyhash-' || id WHERE label LIKE '%${MARKER}%'`
	);
	if (marked !== 1)
		throw new Error(`error-printer: expected 1 row marked pending, marked ${marked}`);
	sql(`CREATE TRIGGER errorprinter_transaction BEFORE UPDATE ON "Transaction"
		WHEN OLD.label LIKE '%${MARKER}%' BEGIN SELECT RAISE(ABORT, 'refused row ' || OLD.label); END`);
	const recompute = boot();
	recomputeBoot = { exitCode: await untilExit(recompute), captured: recompute.captured() };

	// 4. A boot the environment report refuses, which is a message written for the operator.
	const refused = boot({ RATE_LIMIT_HASH_SECRET: '' });
	refusedBoot = { exitCode: await untilExit(refused), captured: refused.captured() };
});

function shownErrorId(): string {
	return /Error reference: ([0-9a-f-]{36})/.exec(pageFailure.html)?.[1] ?? '';
}

test.afterAll(() => {
	rmSync(DB_DIR, { recursive: true, force: true });
});

test.describe('calibration', () => {
	test('the request capture holds the application output and request data', () => {
		// Every absence below is meaningless if the pipe is empty or the search cannot see into it.
		expect(requestCapture).toContain('[budgetpilot] startup:');
		expect(requestCapture).toContain(`[404] GET /${CONTROL_PATH}`);
	});

	test('the forced action failed with a 500 and SvelteKit generic message', () => {
		expect([actionFailure.status, actionFailure.message]).toEqual([500, 'Internal Error']);
	});

	test('the boot recompute was reached and the boot failed', () => {
		expect(recomputeBoot.captured).toContain('[dedupe-keys] recomputing deduplication keys');
		expect(recomputeBoot.exitCode).toBe(1);
	});
});

test.describe('request path', () => {
	test('a failed action returns an error id', () => {
		expect(actionFailure.errorId).toMatch(ERROR_ID);
	});

	test('the log line for a failed action is status, method, path, that error id, class and code', () => {
		// The whole line, so a message riding along after the code would fail it.
		expect(requestCapture).toContain(
			`[500] POST /categories errorId=${actionFailure.errorId} PrismaClientKnownRequestError(P2003)\n`
		);
	});

	test('the database message is not in the log', () => {
		// Present in the capture before the fix: SQLite's adapter text, which SvelteKit's default
		// printer wrote as the first line of the stack.
		expect(count(requestCapture, 'Foreign key constraint violated')).toBe(0);
	});

	test('no stack frame is in the log', () => {
		expect(requestCapture.match(/^\s+at .+$/gm) ?? []).toEqual([]);
	});

	test('a failed page shows an error id', () => {
		expect(pageFailure.status).toBe(500);
		expect(shownErrorId()).toMatch(ERROR_ID);
	});

	test('the log carries the id the failed page shows', () => {
		expect(requestCapture).toContain(`[500] GET /categories errorId=${shownErrorId()} `);
	});
});

test.describe('boot path', () => {
	test('a refused recompute write is logged by class and code', () => {
		expect(recomputeBoot.captured).toContain(
			'[budgetpilot] fatal unhandledRejection: PrismaClientKnownRequestError(P2003)\n'
		);
	});

	test('the refused row is not in the log', () => {
		// 1 before the fix, through the nested `originalMessage` Node's printer walked.
		expect(count(recomputeBoot.captured, MARKER)).toBe(0);
	});

	test('a boot refusal written for the operator is logged with its message', () => {
		// The other side of the rule. Reduced to its class name, the environment report naming every
		// missing variable would cost one restart per variable, which is what assertConfigured.ts
		// exists to prevent.
		expect(refusedBoot.captured).toContain(
			'[budgetpilot] fatal unhandledRejection: OperatorFacingError: BudgetPilot cannot start: one configuration problem.'
		);
	});

	test('the refusal names the variable, and the boot exits 1', () => {
		expect(refusedBoot.captured).toContain('RATE_LIMIT_HASH_SECRET is required');
		expect(refusedBoot.exitCode).toBe(1);
	});
});
