import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Readable } from 'node:stream';
import { request as apiRequest, type APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * Log injection probe for `v5.0.0-16.4.1`, against the SHIPPED artifact (`node build/index.js`).
 *
 * A log line a reader can split is a log line an attacker can forge. Every attacker-reachable
 * input this application has is given a payload carrying the five ways a line is split or
 * repainted: CR, LF, U+2028 and U+2029 (which a viewer that honours Unicode line breaks renders as
 * new lines, and which `JSON.stringify` leaves raw), and an ANSI escape (which repaints a terminal).
 * An over-long value rides with them, because Docker splits a line longer than 16 KiB into two
 * records and the second half then reads as a line of its own.
 *
 * WHAT IS COUNTED, over everything the server wrote to stdout and stderr:
 *
 *  - lines that do not parse as exactly one JSON object;
 *  - raw separators and controls anywhere in the capture: CR, U+2028, U+2029, ESC, any other C0
 *    control, DEL, and any C1 control (LF is the line terminator and is the only one allowed);
 *  - the longest line, in bytes.
 *
 * THE PLANTED CONTROL, because an absence of raw separators is also what a probe that read nothing
 * reports. A second boot is refused for a malformed operator bound whose value carries the same
 * payload, and the refusal is an `OperatorFacingError` whose message the log prints in full. That
 * message is the one channel by design where a planted string reaches the log, so the control must
 * be SEEN there: the refusal line must decode to the planted separators, while the raw capture
 * holds none of them. An operator's environment is not attacker input; the control calibrates the
 * capture and the serialiser, and the request battery is what measures the attack surface.
 *
 * WHAT EACH REQUEST IS, with the reason the payload is shaped the way it is for that input:
 *
 *  - path and query: sent percent-encoded, which is the only form a client can send;
 *  - headers (User-Agent, Referer, X-Forwarded-For, X-Request-Id, Accept-Language, Cookie): sent on
 *    a raw socket as bytes, U+2028 and U+2029 as their UTF-8 bytes, which Node reads as latin1, so
 *    the server holds C1 controls. CR, LF and ESC cannot be carried in a header: one ESC request is
 *    sent anyway and Node's own parser answers it 400 before the application runs;
 *  - form fields (sign-in, registration, a category name) and an import upload's file name and cells:
 *    sent raw, the payload and the over-long value both;
 *  - a forced 500 on a route whose path carries the payload, because the error printer is the line
 *    that writes request data.
 *
 * Its figures are printed on every run beside what it read, and the red run on the tree before the
 * structured logger is the measurement this gate was written from.
 */

// No retries, whatever the suite sets: a log line that splits on one run in three is a defect, and
// a retry that passes would hide it.
test.describe.configure({ retries: 0 });

const PORT = 4181;
const BASE_URL = `http://localhost:${PORT}`;
const DB_DIR = path.resolve('e2e/.data/loginjection');
const DB_FILE = path.join(DB_DIR, 'loginjection.sqlite');
const DATABASE_URL = 'file:./e2e/.data/loginjection/loginjection.sqlite';
const EMAIL = 'loginjection@budgetpilot.test';
const PASSWORD = 'LogInjection-Passw0rd!';

/** The five splitters, in one value, around text a forger would want on a line of its own. */
// DEL, NEL (U+0085) and CSI (U+009B, the one-byte form of ESC [) are what JSON.stringify leaves
// raw besides U+2028 and U+2029, so only this logger's serialiser escapes them: without them the
// probe stayed green with the serialiser's DEL and C1 escaping removed (contradiction pass on L2).
const PAYLOAD =
	'bp-inject-7f3e\r\n{"event_name":"forged"}\u2028FORGED-LS\u2029FORGED-PS\u001b[31mRED\u001b[0m' +
	'DEL\u007fNEL\u0085CSI\u009b31mC1';
const OVERLONG = 'L'.repeat(20_000);
/** Header form: the payload without CR, LF and ESC, as the raw UTF-8 bytes a socket carries. */
const HEADER_PAYLOAD = Buffer.from(
	'bp-inject-7f3e {"event_name":"forged"}\u2028FORGED-LS\u2029FORGED-PS',
	'utf8'
).toString('latin1');

const SERVER_ENV = {
	DATABASE_URL,
	DATABASE_PROVIDER: 'sqlite',
	PORT: String(PORT),
	ORIGIN: BASE_URL,
	NODE_ENV: 'production',
	PUBLIC_INSTANCE: 'false',
	REGISTRATION_MODE: 'admin_only',
	// 12, the floor: a lower cost is refused at boot (#754), and 4 was always clamped to 12.
	PASSWORD_HASH_COST: '12',
	BOOTSTRAP_TOKEN: 'loginjection-bootstrap-token-2a7d',
	RATE_LIMIT_HASH_SECRET: 'abba'.repeat(16),
	TOTP_ENCRYPTION_KEY: 'c0de'.repeat(16),
	LLM_ENABLED: 'false'
};

/** Every character that may not appear raw in a log line, named. LF is the terminator. */
const RAW_KINDS: Record<string, RegExp> = {
	CR: /\r/g,
	LS: /\u2028/g,
	PS: /\u2029/g,
	// eslint-disable-next-line no-control-regex -- this detector exists to find control characters
	ESC: /\u001b/g,
	// eslint-disable-next-line no-control-regex -- same reason
	otherC0: /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f]/g,
	TAB: /\t/g,
	DEL: /\u007f/g,
	C1: /[\u0080-\u009f]/g
};

interface Figures {
	lines: number;
	bytes: number;
	nonJsonLines: number;
	maxLineBytes: number;
	raw: Record<string, number>;
}

/** The detector. Pure, so the planted positive below can run it over a known-bad line. */
function measure(capture: string): Figures {
	const lines = capture.split('\n');
	if (lines.at(-1) === '') lines.pop();
	const nonJsonLines = lines.filter((line) => {
		try {
			const value: unknown = JSON.parse(line);
			return !(value !== null && typeof value === 'object' && !Array.isArray(value));
		} catch {
			return true;
		}
	}).length;
	return {
		lines: lines.length,
		bytes: Buffer.byteLength(capture),
		nonJsonLines,
		maxLineBytes: Math.max(0, ...lines.map((line) => Buffer.byteLength(line))),
		raw: Object.fromEntries(
			Object.entries(RAW_KINDS).map(([kind, pattern]) => [
				kind,
				capture.match(pattern)?.length ?? 0
			])
		)
	};
}

const NO_RAW = Object.fromEntries(Object.keys(RAW_KINDS).map((kind) => [kind, 0]));

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
	throw new Error(`log-injection: server never became reachable\n${server.captured()}`);
}

/** One HTTP/1.1 request written as bytes, so header values are exactly what this file chose. */
function rawRequest(lines: string[]): Promise<number> {
	return new Promise((resolve, reject) => {
		const socket = connect(PORT, '127.0.0.1', () => {
			socket.write(Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'));
		});
		let response = '';
		socket.on('data', (chunk: Buffer) => {
			response += chunk.toString('latin1');
			const status = /^HTTP\/1\.1 (\d{3})/.exec(response)?.[1];
			if (status) {
				socket.destroy();
				resolve(Number(status));
			}
		});
		socket.on('error', reject);
		socket.setTimeout(10_000, () => {
			socket.destroy();
			reject(new Error('log-injection: raw request timed out'));
		});
	});
}

function sql(statement: string): void {
	const db = new DatabaseSync(DB_FILE);
	try {
		db.exec(statement);
	} finally {
		db.close();
	}
}

let requestCapture = '';
let refusalCapture = '';
let refusalExit: number | null = null;
const outcomes: Record<string, string> = {};

test.beforeAll(async () => {
	if (!existsSync('build/index.js')) {
		throw new Error('log-injection: build/index.js is absent, so there is no artifact to boot');
	}
	rmSync(DB_DIR, { recursive: true, force: true });
	mkdirSync(DB_DIR, { recursive: true });
	execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
		env: { ...process.env, DATABASE_URL, DATABASE_PROVIDER: 'sqlite' },
		stdio: 'ignore'
	});

	// The one channel that reaches a logged field RAW, so the serialiser is the only thing between the
	// planted characters and the line: `hooks.server.ts` writes the configured ORIGIN as
	// `budgetpilot.config.origin`. adapter-node accepts it because the payload sits in the path of a
	// valid URL (it percent-encodes the path and keeps only the origin), so forms keep working. The
	// operator's environment is not attacker input: this is the planted control, end to end.
	const server = boot({ ORIGIN: `${BASE_URL}/${PAYLOAD}` });
	let client: APIRequestContext | undefined;
	try {
		await waitForServer(server);
		client = await apiRequest.newContext({
			baseURL: BASE_URL,
			storageState: { cookies: [], origins: [] },
			extraHTTPHeaders: { Origin: BASE_URL, Accept: 'application/json' }
		});
		const api = client;
		const action = async (label: string, url: string, fields: Record<string, string>) => {
			const response = await api.post(url, { form: fields, maxRedirects: 0 });
			outcomes[label] =
				`${response.status()} ${((await response.json()) as { type: string }).type}`;
		};
		const encoded = encodeURIComponent(PAYLOAD);

		// Path and query, before any account exists.
		outcomes['path-404'] = String((await api.get(`/${encoded}`)).status());
		outcomes['path-overlong'] = String((await api.get(`/${'P'.repeat(8_000)}`)).status());
		outcomes['query'] = String(
			(await api.get(`/login?redirectTo=${encoded}&q=${encoded}`, { maxRedirects: 0 })).status()
		);

		// Headers, as bytes.
		outcomes['headers'] = String(
			await rawRequest([
				'GET /login HTTP/1.1',
				`Host: localhost:${PORT}`,
				`User-Agent: ${HEADER_PAYLOAD}`,
				`Referer: http://localhost:${PORT}/${HEADER_PAYLOAD}`,
				`X-Forwarded-For: ${HEADER_PAYLOAD}`,
				`X-Request-Id: ${HEADER_PAYLOAD}`,
				`Accept-Language: ${HEADER_PAYLOAD}`,
				`Cookie: budgetpilot_session=${HEADER_PAYLOAD}; PARAGLIDE_LOCALE=${HEADER_PAYLOAD}`,
				'Connection: close'
			])
		);
		outcomes['header-esc'] = String(
			await rawRequest([
				'GET /login HTTP/1.1',
				`Host: localhost:${PORT}`,
				`User-Agent: esc\u001b[31mRED`,
				'Connection: close'
			])
		);

		// Form fields, anonymous: a sign-in for an unknown account, and a registration whose token is
		// wrong, each carrying the payload and the over-long value.
		await action('login-payload', '/login', { email: PAYLOAD, password: PAYLOAD + OVERLONG });
		await action('register-payload', '/register', {
			email: PAYLOAD,
			password: OVERLONG,
			bootstrapToken: PAYLOAD
		});

		// An account, then the inputs only a signed-in user reaches.
		await action('register', '/register', {
			email: EMAIL,
			password: PASSWORD,
			bootstrapToken: SERVER_ENV.BOOTSTRAP_TOKEN
		});
		await action('login', '/login', { email: EMAIL, password: PASSWORD });
		await action('category-payload', '/categories?/createCategory', {
			name: PAYLOAD + OVERLONG
		});
		const upload = await api.post('/import', {
			multipart: {
				csvFile: {
					name: `${PAYLOAD}.csv`,
					mimeType: 'text/csv',
					buffer: Buffer.from(
						`Date;Libelle;Montant\n15/09/2026;"${PAYLOAD}";-12,34\n16/09/2026;${OVERLONG};-1,00\n`,
						'utf8'
					)
				}
			},
			maxRedirects: 0
		});
		outcomes['import-payload'] =
			`${upload.status()} ${((await upload.json()) as { type: string }).type}`;

		// The error printer, on a path that carries the payload. Last, because with `Session` renamed
		// away every request this signed-in client makes fails in `handleAuth`, before any route
		// runs, which is what lets an unmatched path reach the printer as a 500 rather than a 404.
		sql('ALTER TABLE "Session" RENAME TO "Session_loginjection"');
		try {
			outcomes['forced-500'] = String(
				(await api.get(`/${encoded}`, { headers: { Accept: 'text/html' } })).status()
			);
		} finally {
			sql('ALTER TABLE "Session_loginjection" RENAME TO "Session"');
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	} finally {
		await client?.dispose();
		server.process.kill('SIGTERM');
		await server.exited;
		requestCapture = server.captured();
	}

	// The planted control: a boot refused for a malformed bound whose value is the payload.
	const refused = boot({ IMPORT_RATE_LIMIT_MAX_ATTEMPTS: PAYLOAD + OVERLONG });
	refusalExit = await Promise.race([
		refused.exited,
		new Promise<number | null>((resolve) =>
			setTimeout(() => {
				refused.process.kill('SIGTERM');
				resolve(-1);
			}, 30_000)
		)
	]);
	refusalCapture = refused.captured();

	console.log(
		`[log-injection] request capture ${JSON.stringify(measure(requestCapture))}; refusal capture ${JSON.stringify(measure(refusalCapture))}`
	);
});

test.afterAll(() => {
	rmSync(DB_DIR, { recursive: true, force: true });
});

test.describe('calibration', () => {
	test('every planted request reached what it was aimed at', () => {
		// A 404 on a route that exists, or an `error` from an action, would mean the payload never
		// reached the code that could have logged it. The two expected refusals are named: the
		// unknown route, and Node's parser refusing an ESC in a header before the application runs.
		expect(outcomes).toEqual({
			'path-404': '404',
			'path-overlong': '404',
			query: '200',
			headers: '200',
			'header-esc': '400',
			// SvelteKit answers a refused form action with HTTP 200 and `type: failure`.
			'login-payload': '200 failure',
			'register-payload': '200 failure',
			register: '200 redirect',
			login: '200 redirect',
			'category-payload': '200 failure',
			// Measured, not chosen: the raw CR, LF and quote in this upload's file name make
			// `request.formData()` throw before the action runs (#859). Kept, because it is the request
			// that carries the payload to the error printer through a multipart body.
			'import-payload': '500 error',
			'forced-500': '500'
		});
	});

	test('the refused boot was refused, and the request capture holds the application output', () => {
		expect(refusalExit).toBe(1);
		expect(measure(requestCapture).lines).toBeGreaterThan(0);
	});

	test('the detector reports every raw kind in a line built to carry them', () => {
		// The planted positive for the detector itself: one line per kind, so a pattern that
		// matched nothing would leave its kind at zero here and in the real capture alike.
		const planted = '\r \u2028 \u2029 \u001b \u0001 \t \u007f \u0085 not json\n';
		expect(measure(planted)).toEqual({
			lines: 1,
			bytes: Buffer.byteLength(planted),
			nonJsonLines: 1,
			maxLineBytes: Buffer.byteLength(planted) - 1,
			raw: { CR: 1, LS: 1, PS: 1, ESC: 1, otherC0: 1, TAB: 1, DEL: 1, C1: 1 }
		});
	});
});

test.describe('v5.0.0-16.4.1: no input can split or repaint a log line', () => {
	test('the planted control is in the startup origin line, escaped, every kind of it', () => {
		// Seen, not merely absent: the line decodes to the planted characters, while the raw capture
		// holds none of them (the raw-kind test below). Removing any range from the serialiser
		// leaves its characters raw in this line.
		const line = requestCapture
			.split('\n')
			.map((entry) => {
				try {
					return JSON.parse(entry) as Record<string, unknown>;
				} catch {
					return {};
				}
			})
			.find((entry) => entry.event_name === 'budgetpilot.config.origin_set');
		const origin = String(line?.['budgetpilot.config.origin'] ?? '');
		expect(
			[0x2028, 0x2029, 0x1b, 0x7f, 0x85, 0x9b].map((code) =>
				origin.includes(String.fromCodePoint(code))
			)
		).toEqual([true, true, true, true, true, true]);
	});

	test('every line of the request capture is one JSON object', () => {
		expect(measure(requestCapture).nonJsonLines).toBe(0);
	});

	test('no raw separator or control is in the request capture', () => {
		expect(measure(requestCapture).raw).toEqual(NO_RAW);
	});

	test('every line of the refused boot is one JSON object', () => {
		expect(measure(refusalCapture).nonJsonLines).toBe(0);
	});

	test('no raw separator or control is in the refused boot capture', () => {
		expect(measure(refusalCapture).raw).toEqual(NO_RAW);
	});

	test('no line is long enough for Docker to split it', () => {
		// Docker's json-file driver splits at 16 KiB; the over-long values above would cross it.
		expect(
			Math.max(measure(requestCapture).maxLineBytes, measure(refusalCapture).maxLineBytes)
		).toBeLessThan(16_384);
	});

	test('the planted control is in the refused boot line, escaped', () => {
		// Seen, not merely absent: the line decodes to text holding the planted separators, so the
		// payload travelled through the logger and the serialiser escaped it on the way out.
		// `JSON.stringify` leaves U+2028 and U+2029 raw, so re-serialising a parsed line shows them.
		const refusalLines = refusalCapture
			.split('\n')
			.filter((line) => line.includes('IMPORT_RATE_LIMIT_MAX_ATTEMPTS'));
		const decoded = refusalLines
			.map((line) => {
				try {
					return JSON.stringify(JSON.parse(line));
				} catch {
					return '';
				}
			})
			.join('');
		expect({
			refusalLines: refusalLines.length,
			escapedLS: refusalCapture.includes('\\u2028'),
			escapedPS: refusalCapture.includes('\\u2029'),
			decodedLS: decoded.includes('\u2028'),
			decodedPS: decoded.includes('\u2029')
		}).toEqual({
			refusalLines: 1,
			escapedLS: true,
			escapedPS: true,
			decodedLS: true,
			decodedPS: true
		});
	});
});
