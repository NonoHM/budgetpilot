import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Readable } from 'node:stream';
import { request as apiRequest, type APIRequestContext } from '@playwright/test';
import * as OTPAuth from 'otpauth';
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
 * WHAT IT PLANTS, AND HOW EACH VALUE COMES TO EXIST. Two kinds, because a sweep can only search
 * for what it holds:
 *
 *  - CONFIGURED values, known before the server starts: the bootstrap token, the two key secrets,
 *    the passwords this run types, the email, the database path, and the Enable Banking private
 *    key (a fresh RSA key generated for this run, passed inline as the operator would).
 *  - MINTED values, which exist only because a flow produced them during the run, so each one is
 *    taken from the response or the request that carried it (#835): the session tokens, the TOTP
 *    secret and the recovery codes (by enrolling TOTP), the invitation token (by creating an
 *    invitation), the temporary password (by an admin reset), and the bank authorisation `state`,
 *    `code` and signed bearer token (by running the consent flow against an https stub of the
 *    Enable Banking API that records what the application sent it). Each minted value is also
 *    USED where the application would use it: a recovery code signs in, the invitation registers
 *    the second account, the temporary password signs that account in, and the `code` and `state`
 *    complete the consent. A value only generated and never submitted would leave the submission
 *    path unread.
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
 * adapter-node) rather than `vite preview`, which the suite's own server is. Bank sync is on for
 * this server only, pointed at the stub, which no other spec can reach.
 *
 * THE CALIBRATIONS, because this is an absence assertion and the Phase 4 run of the same method
 * failed all three at once before it was fixed. It reported a confident "0 bytes logged" that was
 * true for reasons unrelated to logging: the markers were written into a file the server held open
 * at a fixed offset and were silently overwritten, and the requests were hitting a wrong endpoint
 * and 404ing. Two independent errors, both pointing the same way.
 *
 *  1. THE CAPTURE IS LIVE. A request for a path that does not exist must have written its
 *     `budgetpilot.request.not_found` line. The path itself is never logged (only the route
 *     template is, #250), so the canary in it must be ABSENT, and the line must be there.
 *  2. THE EVENTS HAPPENED. Every fired request's outcome is asserted against a declared value, so
 *     a battery that 404s its way through the auth paths cannot report a clean log, and every
 *     minted canary must have been obtained in the shape its generator produces.
 *  3. THE APPLICATION'S OWN OUTPUT IS THERE. The `sys_startup` line must be present, so a
 *     capture that somehow held only one stream would not pass as a whole log.
 *  4. THE ERROR PATH WROTE. The forced 500 must have answered 500 with an error id, and that id
 *     must be in the capture, so the one path most likely to carry a secret (#816) is read.
 *
 * Earlier break-checks, kept because they still describe the first three: dropping the STDERR
 * listener turned calibration 1 red and left 3 green, dropping STDOUT did the reverse, and firing
 * the auth paths at a route that does not exist turned 2 red. In every one of those, THE SECRET
 * SCAN ITSELF STAYED GREEN, over a capture that was half empty or over an application that had
 * been asked to do nothing.
 *
 * WHY THE FORCED 500 QUOTES THE EMAIL. A trigger makes the `User` update fail inside SQLite's
 * `json_extract` with the email as the path, so SQLite's own message, « bad JSON path: '<email>' »,
 * becomes the error's message. A trigger that RAISEs would not do: the SQLite adapter replaces a
 * constraint message with a fixed one, and the email would be absent whatever the printer did
 * (`error-printer.spec.ts` records the same limit). With the message carrying a planted value, a
 * printer that writes messages turns the sweep red, which is the break that proves this path.
 */

// No retries, whatever the suite sets (playwright.config.ts retries twice for a hydration race this
// file cannot have). A secret that reaches the log on one run in three is a leak, and a retry that
// passes would hide it: measured, a failing test here was retried twice under the suite default.
test.describe.configure({ retries: 0 });

const PORT = 4176;
const BASE_URL = `http://localhost:${PORT}`;
const DB_DIR = path.resolve('e2e/.data/logscan');
// Distinctive on purpose: the scan searches for this substring, so the database path is one of
// the secrets under test rather than an incidental string.
const DB_FILE = 'logscan-canary-db.sqlite';
const DATABASE_URL = `file:./e2e/.data/logscan/${DB_FILE}`;
const TLS_KEY = path.join(DB_DIR, 'stub-key.pem');
const TLS_CERT = path.join(DB_DIR, 'stub-cert.pem');

/** A fresh signing key for this run. PKCS#8, which is what `jose.importPKCS8` reads. */
const BANK_PRIVATE_KEY = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	publicKeyEncoding: { type: 'spki', format: 'pem' }
}).privateKey;
// Whole 64-character lines of the key's base64 body. A slice of the joined body would straddle a
// line break and miss the wrapped PEM; a whole line is a substring of both the wrapped form and
// the unwrapped one. The FIRST line as well as one from the middle, because a log that cuts a
// value at a length keeps its beginning: a key printed through a capped field leaks its first
// lines, and a canary taken only from the middle would not see that (measured on the logger
// branch, where `budgetpilot.console.text` is capped at 256 characters).
const BANK_PRIVATE_KEY_LINES = BANK_PRIVATE_KEY.split('\n').filter(
	(line) => line && !line.startsWith('-----')
);

/**
 * Every configured value the scan must never find, chosen to be unmistakable.
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
	memberPassword: 'MemberCanaryPassw0rd-3b6a!',
	email: 'logscan-canary@budgetpilot.test',
	memberEmail: 'logscan-member-canary@budgetpilot.test',
	databasePath: DB_FILE,
	bankPrivateKeyFirstLine: BANK_PRIVATE_KEY_LINES[0],
	bankPrivateKeyMiddleLine: BANK_PRIVATE_KEY_LINES[Math.floor(BANK_PRIVATE_KEY_LINES.length / 2)],
	bankAuthorizationCode: 'logscan-canary-bank-code-61c0e7'
};

/** Values minted during the run, filled by `exerciseAuthPaths`. Each is asserted non-empty. */
const minted = {
	sessionToken: '',
	recoverySessionToken: '',
	totpSecret: '',
	recoveryCodes: [] as string[],
	invitationToken: '',
	temporaryPassword: '',
	bankState: '',
	bankBearerTokens: [] as string[]
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
	// bcrypt's floor. This instance exists for ten seconds and hashes a few passwords; the cost
	// factor is not what this check is about, and 12 would spend seconds proving nothing.
	PASSWORD_HASH_COST: '4',
	BOOTSTRAP_TOKEN: SECRETS.bootstrapToken,
	RATE_LIMIT_HASH_SECRET: SECRETS.rateLimitSecret,
	TOTP_ENCRYPTION_KEY: SECRETS.totpKey,
	LLM_ENABLED: 'false',
	BANK_SYNC_ENABLED: 'true',
	BANK_SYNC_ALLOWED_HOSTS: '127.0.0.1',
	BANK_SYNC_REDIRECT_ALLOWED_ORIGINS: BASE_URL,
	ENABLE_BANKING_APP_ID: 'logscan-app-id',
	// Inline with literal "\n", the form `.env.example` documents for this variable.
	ENABLE_BANKING_PRIVATE_KEY: BANK_PRIVATE_KEY.replace(/\n/g, '\\n'),
	// The stub's self-signed certificate, so the application's https client trusts it without the
	// application learning anything about tests: the same variable an operator uses for a private CA.
	NODE_EXTRA_CA_CERTS: TLS_CERT
};

// `stdio: ['ignore', 'pipe', 'pipe']` gives a child with no stdin, which is a different type
// from the all-piped default. Named exactly, so the two readable streams stay non-nullable.
let server: ChildProcessByStdio<null, Readable, Readable>;
let bankStub: BankStub;
let captured = '';
let admin: APIRequestContext;
const contexts: APIRequestContext[] = [];
const outcomes: Record<string, string> = {};
let forcedErrorId = '';

interface BankStub {
	server: HttpsServer;
	port: number;
	hits: Record<string, number>;
	states: string[];
	codes: string[];
	bearers: string[];
}

/**
 * An https stand-in for the Enable Banking API: answers the six requests the consent flow and a
 * first sync make, with the smallest bodies the connector's schemas accept, and records the
 * `state`, the `code` and the bearer token it is sent, which are the minted secrets this scan
 * needs. It never answers anything the real API would refuse to.
 */
async function startBankStub(): Promise<BankStub> {
	const stub: BankStub = {
		server: undefined as unknown as HttpsServer,
		port: 0,
		hits: {},
		states: [],
		codes: [],
		bearers: []
	};
	stub.server = createServer(
		{ key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) },
		(request, response) => {
			let body = '';
			request.on('data', (chunk: Buffer) => (body += chunk.toString()));
			request.on('end', () => {
				const url = new URL(request.url ?? '/', 'https://127.0.0.1');
				const route = url.pathname.replace(/^\/(sessions|accounts)\/[^/]+/, '/$1/:id');
				const key = `${request.method} ${route}`;
				stub.hits[key] = (stub.hits[key] ?? 0) + 1;
				const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
				if (bearer) stub.bearers.push(bearer);
				const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
				const validUntil = new Date(Date.now() + 30 * 86_400_000).toISOString();
				const answer = (status: number, payload: unknown) => {
					response.writeHead(status, { 'content-type': 'application/json' });
					response.end(JSON.stringify(payload));
				};
				switch (key) {
					case 'GET /aspsps':
						return answer(200, { aspsps: [{ name: 'Logscan Bank', country: 'FR' }] });
					case 'POST /auth':
						stub.states.push(String(parsed.state));
						return answer(200, {
							url: `https://127.0.0.1:${stub.port}/consent`,
							authorization_id: 'stub-authorization'
						});
					case 'POST /sessions':
						stub.codes.push(String(parsed.code));
						return answer(200, {
							session_id: 'stub-session',
							accounts: [{ uid: 'stub-account', name: 'Compte stub', currency: 'EUR' }],
							access: { valid_until: validUntil }
						});
					case 'GET /sessions/:id':
						return answer(200, {
							status: 'AUTHORIZED',
							accounts: ['stub-account'],
							access: { valid_until: validUntil }
						});
					case 'GET /accounts/:id/balances':
						return answer(200, { balances: [] });
					case 'GET /accounts/:id/transactions':
						return answer(200, { transactions: [] });
					default:
						return answer(404, { error: 'NOT_FOUND' });
				}
			});
		}
	);
	await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve));
	stub.port = (stub.server.address() as AddressInfo).port;
	return stub;
}

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
	// A certificate for the stub, valid one day, generated here so no key material is tracked.
	execFileSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			TLS_KEY,
			'-out',
			TLS_CERT,
			'-days',
			'1',
			'-subj',
			'/CN=127.0.0.1',
			'-addext',
			'subjectAltName=IP:127.0.0.1'
		],
		{ stdio: 'ignore' }
	);
	bankStub = await startBankStub();

	server = spawn('node', ['build/index.js'], {
		env: {
			...process.env,
			...SERVER_ENV,
			ENABLE_BANKING_BASE_URL: `https://127.0.0.1:${bankStub.port}`
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	// Both streams into one buffer, in arrival order: a secret is equally disclosed by either.
	server.stdout.on('data', (chunk: Buffer) => (captured += chunk.toString()));
	server.stderr.on('data', (chunk: Buffer) => (captured += chunk.toString()));

	await waitForServer();
	admin = await newClient();

	await exerciseAuthPaths();
	// The error line is written before the response completes, but give the pipe a moment.
	await new Promise((resolve) => setTimeout(resolve, 300));
	console.log(
		`[log-secret-scan] read ${captured.split('\n').length - 1} lines, ${Buffer.byteLength(captured)} bytes; searched ${Object.keys(SECRETS).length} configured and ${mintedValues().length} minted values`
	);
});

test.afterAll(async () => {
	for (const context of contexts) await context.dispose();
	server?.kill('SIGTERM');
	await new Promise<void>((resolve) =>
		bankStub ? bankStub.server.close(() => resolve()) : resolve()
	);
	rmSync(DB_DIR, { recursive: true, force: true });
});

async function newClient(): Promise<APIRequestContext> {
	const context = await apiRequest.newContext({
		baseURL: BASE_URL,
		// This server is not the suite's, so the shared storageState would be a session it has
		// never issued. Pinned empty for the same reason as in idor-two-account.spec.ts.
		storageState: { cookies: [], origins: [] },
		// JSON so each action's outcome is readable: SvelteKit answers a form action with an
		// ActionResult whose `type` says what happened, which an HTML 200 does not.
		extraHTTPHeaders: { Origin: BASE_URL, Accept: 'application/json' }
	});
	contexts.push(context);
	return context;
}

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

/**
 * The top level of an ActionResult's `data`, which SvelteKit serialises with devalue: a flat
 * JSON array whose first element maps each key to the index of its value. Enough for the strings,
 * arrays of strings and plain objects these actions return.
 */
function actionData(data: string | undefined): Record<string, unknown> {
	if (!data) return {};
	const flat = JSON.parse(data) as unknown[];
	const resolve = (index: number): unknown => {
		const value = flat[index];
		if (Array.isArray(value)) return value.map((entry) => resolve(entry as number));
		if (value && typeof value === 'object') {
			return Object.fromEntries(
				Object.entries(value).map(([key, entry]) => [key, resolve(entry as number)])
			);
		}
		return value;
	};
	return resolve(0) as Record<string, unknown>;
}

/** One statement against this run's private database, opened and closed around it. */
function sqlite<T>(run: (db: DatabaseSync) => T): T {
	const db = new DatabaseSync(path.join(DB_DIR, DB_FILE));
	try {
		return run(db);
	} finally {
		db.close();
	}
}

const sessionCookie = (setCookie: string | undefined) =>
	/budgetpilot_session=([^;]+)/.exec(setCookie ?? '')?.[1] ?? '';

/** The canary that proves the capture is live. Read back out of the log, not merely sent. */
const PATH_CANARY = 'canary-path-4d7b2e-do-not-remove';

async function exerciseAuthPaths(): Promise<void> {
	const action = async (
		client: APIRequestContext,
		label: string,
		url: string,
		fields: Record<string, string>
	) => {
		const response = await client.post(url, { form: fields, maxRedirects: 0 });
		const body = (await response.json()) as {
			type: string;
			location?: string;
			data?: string;
			error?: { errorId?: string };
		};
		outcomes[label] = body.type;
		return { response, body, data: actionData(body.data) };
	};

	// 1. A path that does not exist, carrying the canary. The log writes a not-found line without it.
	outcomes['canary-404'] = String(
		(await admin.get(`/${PATH_CANARY}`, { maxRedirects: 0 })).status()
	);

	// 2. Registration. The database is empty, so this is the first account and becomes ADMIN;
	//    admin_only still admits it (userCount === 0). Sends the bootstrap token in a form body.
	await action(admin, 'register', '/register', {
		email: SECRETS.email,
		password: SECRETS.password,
		bootstrapToken: SECRETS.bootstrapToken
	});

	// 3. A successful login, BEFORE the failures: the last step trips the limiter and would block it.
	const login = await action(admin, 'login-success', '/login', {
		email: SECRETS.email,
		password: SECRETS.password
	});
	minted.sessionToken = sessionCookie(login.response.headers()['set-cookie']);

	// 4. TOTP enrolment: the secret comes back from the first step, a code from it confirms, and the
	//    confirmation returns the recovery codes.
	const setup = await action(admin, 'totp-start', '/settings?/startTotpSetup', {});
	minted.totpSecret = String(
		(setup.data.totpSetupPending as { secretBase32?: string } | undefined)?.secretBase32 ?? ''
	);
	const code = new OTPAuth.TOTP({
		secret: OTPAuth.Secret.fromBase32(minted.totpSecret)
	}).generate();
	const confirm = await action(admin, 'totp-confirm', '/settings?/confirmTotpSetup', {
		currentPassword: SECRETS.password,
		secretBase32: minted.totpSecret,
		code
	});
	minted.recoveryCodes = (confirm.data.recoveryCodes as string[] | undefined) ?? [];

	// 5. An invitation, redeemed by a second account from a client with no session.
	const invite = await action(admin, 'invitation-create', '/admin?/createInvitation', {
		email: SECRETS.memberEmail
	});
	minted.invitationToken =
		new URL(String(invite.data.inviteUrl ?? 'http://x/')).searchParams.get('invite') ?? '';
	const member = await newClient();
	await action(
		member,
		'invitation-redeem',
		`/register?invite=${encodeURIComponent(minted.invitationToken)}`,
		{ email: SECRETS.memberEmail, password: SECRETS.memberPassword }
	);

	// 6. An admin reset of that account, and a sign-in with the temporary password it issued.
	// The id the admin page lists beside the account, read from this run's private database.
	const memberId = String(
		sqlite((db) => db.prepare('SELECT id FROM "User" WHERE email = ?').get(SECRETS.memberEmail))
			?.id ?? ''
	);
	const reset = await action(admin, 'admin-reset', '/admin?/resetPassword', {
		targetUserId: memberId
	});
	minted.temporaryPassword = String(reset.data.temporaryPassword ?? '');
	const memberAgain = await newClient();
	await action(memberAgain, 'temporary-password-login', '/login', {
		email: SECRETS.memberEmail,
		password: minted.temporaryPassword
	});

	// 7. The bank consent flow against the stub: start (the application sends `state` to /auth),
	//    then the callback the bank would redirect to, carrying `code` and that `state`.
	const start = await action(admin, 'bank-start', '/imports/bank-connections?/start', {
		bank: 'Logscan Bank',
		country: 'FR'
	});
	minted.bankState = bankStub.states[0] ?? '';
	outcomes['bank-start-location'] = start.body.location?.startsWith(
		`https://127.0.0.1:${bankStub.port}/consent`
	)
		? 'stub-consent'
		: String(start.body.location);
	const callback = await admin.get(
		`/imports/bank-connections/callback?code=${SECRETS.bankAuthorizationCode}&state=${encodeURIComponent(minted.bankState)}`,
		{ maxRedirects: 0 }
	);
	outcomes['bank-callback'] = `${callback.status()} ${callback.headers()['location']}`;
	minted.bankBearerTokens = [...bankStub.bearers];

	// 8. The forced 500, whose error message quotes the email (see the header for why json_extract).
	sqlite((db) =>
		db.exec(`CREATE TRIGGER logscan_force_500 BEFORE UPDATE ON "User"
			BEGIN SELECT json_extract('{}', NEW.email); END`)
	);
	try {
		const forced = await admin.post('/settings?/updateAiInsightsEnabled', {
			form: { enabled: 'true' },
			maxRedirects: 0
		});
		const forcedBody = (await forced.json()) as { type: string; error?: { errorId?: string } };
		outcomes['forced-500'] = `${forced.status()} ${forcedBody.type}`;
		forcedErrorId = forcedBody.error?.errorId ?? '';
	} finally {
		sqlite((db) => db.exec('DROP TRIGGER IF EXISTS logscan_force_500'));
	}

	// 9. A sign-in that needs the second factor, completed with a recovery code.
	const recovery = await newClient();
	await action(recovery, 'mfa-login-password', '/login', {
		email: SECRETS.email,
		password: SECRETS.password
	});
	const verified = await action(recovery, 'mfa-login-recovery-code', '/login/verify-totp', {
		code: minted.recoveryCodes[0] ?? ''
	});
	minted.recoverySessionToken = sessionCookie(verified.response.headers()['set-cookie']);

	// 10. Six failed logins against a real account: five to reach MAX_ATTEMPTS and a sixth that the
	//     limiter refuses, so both the recording path and the refusal path are exercised. Safe here
	//     and nowhere else in this suite, because this database and this server are private to
	//     this file.
	const stranger = await newClient();
	for (let attempt = 1; attempt <= 6; attempt += 1) {
		await action(stranger, `login-fail-${attempt}`, '/login', {
			email: SECRETS.email,
			password: SECRETS.wrongPassword
		});
	}

	// 11. A login for an account that does not exist, which is the other half of the failure path.
	await action(stranger, 'login-unknown-user', '/login', {
		email: 'nobody-canary@budgetpilot.test',
		password: SECRETS.wrongPassword
	});
}

function mintedValues(): [string, string][] {
	return [
		['sessionToken', minted.sessionToken],
		['recoverySessionToken', minted.recoverySessionToken],
		['totpSecret', minted.totpSecret],
		...minted.recoveryCodes.map((value, index): [string, string] => [
			`recoveryCode[${index}]`,
			value
		]),
		['invitationToken', minted.invitationToken],
		['temporaryPassword', minted.temporaryPassword],
		['bankState', minted.bankState],
		...minted.bankBearerTokens.map((value, index): [string, string] => [
			`bankBearerToken[${index}]`,
			value
		]),
		// The signature alone, so a line that logged only the last segment is caught as well.
		...minted.bankBearerTokens.map((value, index): [string, string] => [
			`bankBearerSignature[${index}]`,
			value.split('.')[2] ?? ''
		])
	];
}

test.describe('v5.0.0-16.2.5: no secret reaches the log', () => {
	test('calibration: the capture is live, and the unknown path wrote its line without the path', () => {
		// If this fails, every absence asserted below is meaningless: it would mean the pipe is
		// empty, or the search cannot see what is in it.
		expect(captured.length).toBeGreaterThan(0);
		expect(captured).toContain('"event_name":"budgetpilot.request.not_found"');
		expect(captured).not.toContain(PATH_CANARY);
	});

	test("calibration: the application's own output is in the capture, not only one stream", () => {
		expect(captured).toContain('"event_name":"sys_startup"');
	});

	test('calibration: every exercised path did what it was supposed to, so the log covers real events', () => {
		// `redirect` is a completed sign-in, registration or confirmation; `success` an action that
		// returned data; `failure` a refusal. A 404 or an `error` here would mean the path was never
		// reached and the clean log below describes an application that was asked to do nothing.
		expect(outcomes).toEqual({
			'canary-404': '404',
			register: 'redirect',
			'login-success': 'redirect',
			'totp-start': 'success',
			'totp-confirm': 'success',
			'invitation-create': 'success',
			'invitation-redeem': 'redirect',
			'admin-reset': 'success',
			'temporary-password-login': 'redirect',
			'bank-start': 'redirect',
			'bank-start-location': 'stub-consent',
			'bank-callback': '303 /imports/bank-connections?connected=1',
			'forced-500': '500 error',
			'mfa-login-password': 'redirect',
			'mfa-login-recovery-code': 'redirect',
			'login-fail-1': 'failure',
			'login-fail-2': 'failure',
			'login-fail-3': 'failure',
			'login-fail-4': 'failure',
			'login-fail-5': 'failure',
			'login-fail-6': 'failure',
			'login-unknown-user': 'failure'
		});
	});

	test('calibration: every minted secret was obtained, in the shape its generator produces', () => {
		// A sweep for an empty string finds nothing and proves nothing, so each value is checked
		// against what its producer writes: auth.ts, auth/totp.ts, the invitation module, and the
		// connector's randomUUID state. The stub must have received the code this run sent.
		expect({
			sessionToken: minted.sessionToken.length > 20,
			recoverySessionToken: minted.recoverySessionToken.length > 20,
			totpSecret: /^[A-Z2-7]{32}$/.test(minted.totpSecret),
			recoveryCodes:
				minted.recoveryCodes.length > 0 &&
				minted.recoveryCodes.every((value) => /^[0-9A-F]{5}-[0-9A-F]{5}$/.test(value)),
			invitationToken: minted.invitationToken.length > 20,
			temporaryPassword: /^[A-Za-z0-9_-]{22}$/.test(minted.temporaryPassword),
			bankState: /^[0-9a-f-]{36}$/.test(minted.bankState),
			bankCodeReceived: bankStub.codes.includes(SECRETS.bankAuthorizationCode),
			bankBearerTokens:
				minted.bankBearerTokens.length > 0 &&
				minted.bankBearerTokens.every((value) => value.split('.').length === 3)
		}).toEqual({
			sessionToken: true,
			recoverySessionToken: true,
			totpSecret: true,
			recoveryCodes: true,
			invitationToken: true,
			temporaryPassword: true,
			bankState: true,
			bankCodeReceived: true,
			bankBearerTokens: true
		});
	});

	test('calibration: the forced 500 reached the error printer, which wrote its id', () => {
		expect(forcedErrorId).toMatch(/^[0-9a-f-]{36}$/);
		expect(captured).toContain(forcedErrorId);
	});

	// The planted positive, permanent rather than a one-off: the two sweeps below are run over a copy
	// of this capture with one configured and one minted value appended, and must name both. A
	// sweep that searched nothing, or searched for the wrong values, reports clean on the real
	// capture and fails here. Inclusion rather than a difference against the real capture, so that
	// a capture which already leaks the planted value does not turn this red as well.
	test('calibration: both sweeps report a secret planted in a copy of this capture', () => {
		const planted = `${captured}\n{"leak":"${minted.recoveryCodes[1]}"} ${SECRETS.bankPrivateKeyMiddleLine}\n`;
		expect({
			configured: configuredFoundIn(planted).includes('bankPrivateKeyMiddleLine'),
			minted: mintedFoundIn(planted).includes('recoveryCode[1]')
		}).toEqual({ configured: true, minted: true });
	});

	test('no configured credential, token or key appears anywhere in the captured log', () => {
		const found = configuredFoundIn(captured);
		expect(found, `secrets found in the log: ${found.join(', ')}`).toEqual([]);
	});

	// Separate from the configured sweep because these are LIVE credentials minted during the run,
	// which a list written before the run structurally cannot hold. v5.0.0-16.2.5 allows a session
	// token to be logged only hashed or masked, and the application's position is that none of
	// these is ever logged at all.
	test('no secret minted during this run appears anywhere in the captured log', () => {
		const found = mintedFoundIn(captured);
		expect(found, `minted secrets found in the log: ${found.join(', ')}`).toEqual([]);
	});
});

function configuredFoundIn(text: string): string[] {
	return Object.entries(SECRETS)
		.filter(([, value]) => text.includes(value))
		.map(([name]) => name);
}

function mintedFoundIn(text: string): string[] {
	return mintedValues()
		.filter(([, value]) => value !== '' && text.includes(value))
		.map(([name]) => name);
}
