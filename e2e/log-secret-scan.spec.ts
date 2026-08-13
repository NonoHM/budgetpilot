import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { request as apiRequest, type APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * Secret-absence log assertion: check 3 of the Phase 5 automation inventory, and the port of the
 * Phase 4 method for `v5.0.0-16.2.5` (do not log credentials; log session tokens only hashed or
 * masked).
 *
 * The assessment measured this by hand once: boot the app, exercise the auth paths, search the
 * captured log for every secret in play, and confirm all zero occurrences against a control
 * string known to be present. That verdict describes one afternoon. This runs it every time.
 *
 * IT MATTERS MORE LATER THAN NOW, and that is the argument for building it now. Today the
 * application writes four startup lines and nothing else, so the surface is small and the check
 * is cheap. #250 adds security event logging, which is precisely the change that starts writing
 * authentication data to a stream on purpose, and the day that lands is the day an accidental
 * `console.log(user)` becomes a credential disclosure. A check that already exists and is already
 * green is what turns that into a red build instead of a discovery.
 *
 * WHY IT RUNS ITS OWN SERVER instead of reading the suite's. Three reasons, each measured:
 *
 *  1. Playwright pipes the webServer's output to the terminal and gives no test any way to read
 *     it, so the suite's log is not capturable from inside a spec without changing shared
 *     infrastructure for one check.
 *  2. The method wants a rate-limiter TRIP, and the login limiter is keyed on the client IP with
 *     `MAX_ATTEMPTS = 5` over a 15-minute window (`auth/rateLimit.ts`). Every spec in this suite
 *     shares 127.0.0.1 and one database, so tripping it here would block the logins that
 *     `transactions-filter-persistence.spec.ts` performs later. Measured, not feared: that file
 *     runs after this one alphabetically and calls `loginE2eUser` in a `beforeAll`.
 *  3. The register limiter is not reachable at all in this suite: `.env.test` sets
 *     REGISTRATION_MODE=admin_only, and that branch calls neither `isRegisterRateLimited` nor
 *     `recordRegisterAttempt`.
 *
 * A private server on its own port with its own database removes all three. It costs one
 * `prisma migrate deploy` and one boot, and it is the SHIPPED artifact (`node build/index.js`,
 * adapter-node) rather than `vite preview`, which the suite's own server is.
 *
 * THE THREE CALIBRATIONS, because this is an absence assertion and the Phase 4 run of the same
 * method failed all three at once before it was fixed. It reported a confident "0 bytes logged"
 * that was true for reasons unrelated to logging: the markers were written into a file the server
 * held open at a fixed offset and were silently overwritten, and the requests were hitting a
 * wrong endpoint and 404ing. Two independent errors, both pointing the same way.
 *
 *  1. THE CAPTURE IS LIVE. A canary string is placed in a request PATH, which the adapter logs as
 *     `[404] GET /<canary>`, and the capture must contain it. This proves the pipe works, that
 *     the search works, and specifically that REQUEST-DERIVED DATA reaches the log, which is the
 *     channel a leaked secret would travel down.
 *  2. THE EVENTS HAPPENED. Every fired request's status is asserted against a declared value, so
 *     a battery that 404s its way through the auth paths cannot report a clean log.
 *  3. THE APPLICATION'S OWN OUTPUT IS THERE. The startup line must be present, so a capture that
 *     somehow held only adapter output would not pass as a whole log.
 *
 * ALL THREE ARE LOAD-BEARING AND NONE IS REDUNDANT, which was not obvious before the break-check
 * and is the reason they are three tests rather than one:
 *
 *  - Dropping the STDERR listener turns calibration 1 red and leaves calibration 3 green: the
 *    adapter's `[404]` line is on stderr and the startup lines are on stdout.
 *  - Dropping the STDOUT listener turns calibration 3 red and leaves calibration 1 green, for the
 *    same reason in the other direction.
 *  - Firing the auth paths at a route that does not exist turns calibration 2 red.
 *
 * In every one of those three, THE SECRET SCAN ITSELF STAYED GREEN, over a capture that was half
 * empty or over an application that had been asked to do nothing. That is the vacuous pass these
 * calibrations exist to prevent, observed rather than argued.
 *
 * WHY THE SESSION TOKEN IS ITS OWN TEST rather than another entry in SECRETS. Making
 * `createSession` log the token it issues turns that test red and leaves the general sweep GREEN,
 * because the sweep can only search for values known before the run and the token is minted
 * during it. A leaked session token is exactly the disclosure v5.0.0-16.2.5 singles out, and the
 * general sweep structurally cannot see it.
 *
 * WHICH SECRETS ARE PROVEN CATCHABLE, stated so the list is not read as stronger than it is.
 * Break-checks have shown this scan go red on a logged PASSWORD (a submitted form value), on a
 * logged DATABASE_URL (an environment value), and on a logged SESSION TOKEN (a minted
 * credential). The remaining entries in SECRETS travel one of those same three routes and are
 * searched by the same line, so they are covered by the same evidence rather than by their own
 * break.
 */

const PORT = 4176;
const BASE_URL = `http://localhost:${PORT}`;
const DB_DIR = path.resolve('e2e/.data/logscan');
// Distinctive on purpose: the scan searches for this substring, so the database path is one of
// the secrets under test rather than an incidental string.
const DB_FILE = 'logscan-canary-db.sqlite';
const DATABASE_URL = `file:./e2e/.data/logscan/${DB_FILE}`;

/**
 * Every value the scan must never find, chosen to be unmistakable.
 *
 * Distinctive rather than realistic: a search for a plausible-looking secret can match something
 * incidental, and a search for a value the application never handles is an assertion that cannot
 * fail. These are all values this instance genuinely receives and uses, and none of them could
 * occur in the log by coincidence.
 */
const SECRETS = {
	bootstrapToken: 'bp-canary-bootstrap-token-8f3a91',
	rateLimitSecret: 'cafe'.repeat(16),
	totpKey: 'dead'.repeat(16),
	password: 'CanaryPassw0rd-9d2f!',
	wrongPassword: 'WrongCanaryPassw0rd-7e11!',
	email: 'logscan-canary@budgetpilot.test',
	databasePath: DB_FILE
};

const SERVER_ENV = {
	DATABASE_URL,
	PORT: String(PORT),
	// Required, and its absence is not obvious: without ORIGIN, adapter-node cannot know the
	// public URL it is served under, so SvelteKit's CSRF check compares the request's Origin
	// header against a URL it has guessed and refuses every form POST with 403. Measured here:
	// all nine auth POSTs came back 403 until this line existed, and the status calibration is
	// what said so rather than the log scan quietly passing over an application that had refused
	// to do anything. The suite's own server never meets this because `vite preview` resolves the
	// origin from the request.
	ORIGIN: BASE_URL,
	PUBLIC_INSTANCE: 'false',
	REGISTRATION_MODE: 'admin_only',
	// bcrypt's floor. This instance exists for ten seconds and hashes eight passwords; the cost
	// factor is not what this check is about, and 12 would spend three seconds proving nothing.
	PASSWORD_HASH_COST: '4',
	BOOTSTRAP_TOKEN: SECRETS.bootstrapToken,
	RATE_LIMIT_HASH_SECRET: SECRETS.rateLimitSecret,
	TOTP_ENCRYPTION_KEY: SECRETS.totpKey,
	LLM_ENABLED: 'false'
};

// `stdio: ['ignore', 'pipe', 'pipe']` gives a child with no stdin, which is a different type
// from the all-piped default. Named exactly, so the two readable streams stay non-nullable.
let server: ChildProcessByStdio<null, Readable, Readable>;
let captured = '';
let client: APIRequestContext;
/** Set-Cookie session token from the successful login: a live credential, held to search for. */
let sessionToken = '';
const observedStatuses: Record<string, number> = {};

test.beforeAll(async () => {
	// The artifact must exist before anything else is believed. The suite's own webServer command
	// runs `npm run build` before any spec, so it does; asserting it turns a missing build into a
	// message that says so rather than a spawn that dies with ENOENT.
	if (!existsSync('build/index.js')) {
		throw new Error('log-secret-scan: build/index.js is absent, so there is no artifact to boot');
	}

	rmSync(DB_DIR, { recursive: true, force: true });
	mkdirSync(DB_DIR, { recursive: true });
	// `migrate deploy`, never `migrate reset`, which is forbidden project-wide even on a throwaway.
	execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
		env: { ...process.env, DATABASE_URL },
		stdio: 'ignore'
	});

	server = spawn('node', ['build/index.js'], {
		env: { ...process.env, ...SERVER_ENV },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	// Both streams into one buffer, in arrival order: the startup lines go to stdout, the adapter's
	// error lines to stderr, and a secret is equally disclosed by either.
	server.stdout.on('data', (chunk: Buffer) => (captured += chunk.toString()));
	server.stderr.on('data', (chunk: Buffer) => (captured += chunk.toString()));

	await waitForServer();
	client = await apiRequest.newContext({
		baseURL: BASE_URL,
		// This server is not the suite's, so the shared storageState would be a session it has
		// never issued. Pinned empty for the same reason as in idor-two-account.spec.ts.
		storageState: { cookies: [], origins: [] },
		extraHTTPHeaders: { Origin: BASE_URL }
	});

	await exerciseAuthPaths();
});

test.afterAll(async () => {
	await client?.dispose();
	server?.kill('SIGTERM');
	rmSync(DB_DIR, { recursive: true, force: true });
});

async function waitForServer(timeoutMs = 30_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const response = await fetch(`${BASE_URL}/login`);
			if (response.ok) return;
		} catch {
			// Not accepting connections yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`log-secret-scan: server never became reachable at ${BASE_URL}\n${captured}`);
}

/** The canary that proves the capture is live. Read back out of the log, not merely sent. */
const PATH_CANARY = 'canary-path-4d7b2e-do-not-remove';

async function exerciseAuthPaths(): Promise<void> {
	const form = async (label: string, url: string, fields: Record<string, string>) => {
		const response = await client.post(url, { form: fields, maxRedirects: 0 });
		observedStatuses[label] = response.status();
		return response;
	};

	// 1. A path that does not exist, carrying the canary. The adapter logs `[404] GET /<path>`.
	observedStatuses['canary-404'] = (
		await client.get(`/${PATH_CANARY}`, { maxRedirects: 0 })
	).status();

	// 2. Registration. The database is empty, so this is the first account and becomes ADMIN;
	//    admin_only still admits it (userCount === 0). Sends the bootstrap token in a form body.
	await form('register', '/register', {
		email: SECRETS.email,
		password: SECRETS.password,
		bootstrapToken: SECRETS.bootstrapToken
	});

	// 3. A successful login, BEFORE the failures: step 4 trips the limiter and would block it.
	const login = await form('login-success', '/login', {
		email: SECRETS.email,
		password: SECRETS.password
	});
	sessionToken = /budgetpilot_session=([^;]+)/.exec(login.headers()['set-cookie'] ?? '')?.[1] ?? '';

	// 4. Six failed logins against a real account: five to reach MAX_ATTEMPTS and a sixth that the
	//    limiter refuses, so both the recording path and the refusal path are exercised. Safe here
	//    and nowhere else in this suite, because this database and this server are private to
	//    this file.
	for (let attempt = 1; attempt <= 6; attempt += 1) {
		await form(`login-fail-${attempt}`, '/login', {
			email: SECRETS.email,
			password: SECRETS.wrongPassword
		});
	}

	// 5. A login for an account that does not exist, which is the other half of the failure path.
	await form('login-unknown-user', '/login', {
		email: 'nobody-canary@budgetpilot.test',
		password: SECRETS.wrongPassword
	});
}

test.describe('v5.0.0-16.2.5: no secret reaches the log', () => {
	test('calibration: the capture is live, and request data does reach the log', () => {
		// If this fails, every absence asserted below is meaningless: it would mean the pipe is
		// empty, or the search cannot see what is in it.
		expect(captured.length).toBeGreaterThan(0);
		expect(captured).toContain(PATH_CANARY);
	});

	test("calibration: the application's own output is in the capture, not only the adapter's", () => {
		expect(captured).toContain('[budgetpilot] startup:');
	});

	test('calibration: every exercised path did what it was supposed to, so the log covers real events', () => {
		// A 404 here would mean the auth paths were never reached and the clean log below describes
		// an application that was never asked to do anything. This is the half the Phase 4 run got
		// wrong, and it got it wrong invisibly.
		expect(observedStatuses).toEqual({
			'canary-404': 404,
			register: 200,
			'login-success': 200,
			'login-fail-1': 200,
			'login-fail-2': 200,
			'login-fail-3': 200,
			'login-fail-4': 200,
			'login-fail-5': 200,
			'login-fail-6': 200,
			'login-unknown-user': 200
		});
		// SvelteKit answers a form action with its JSON ActionResult and HTTP 200 whatever the
		// semantic outcome, so the statuses above prove the ROUTES exist and were reached. That the
		// login actually succeeded is proven separately, by the session cookie it issued.
		expect(sessionToken).not.toBe('');
	});

	test('no credential, token or key appears anywhere in the captured log', () => {
		const found = Object.entries(SECRETS)
			.filter(([, value]) => captured.includes(value))
			.map(([name]) => name);

		expect(found, `secrets found in the log: ${found.join(', ')}`).toEqual([]);
	});

	// The sharpest one, and separate because it is a LIVE credential rather than a configured
	// value: the session token this run was issued. v5.0.0-16.2.5 allows a session token to be
	// logged only hashed or masked, and the application's position is that it is never logged at
	// all. Held in hand, so this is not a search for a value that might not exist.
	test('the live session token issued during this run appears nowhere in the log', () => {
		expect(sessionToken.length).toBeGreaterThan(20);
		expect(captured).not.toContain(sessionToken);
	});
});
