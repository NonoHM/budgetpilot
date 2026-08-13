import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import type { Readable } from 'node:stream';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';

/**
 * Error shape and exposed endpoints: check 7 of the Phase 5 automation inventory, covering
 * `v5.0.0-16.5.1` (a generic message on an unexpected error, no stack, query, key or token),
 * `v5.0.0-13.4.2` (debug modes disabled in production), `v5.0.0-13.4.3` (no directory listings),
 * `v5.0.0-13.4.4` (TRACE not supported) and `v5.0.0-13.4.5` (no documentation or monitoring
 * endpoints).
 *
 * `13.4.4` is the row this check exists for. Its published verdict is honest about its own limit:
 * "NOT SEPARATELY MEASURED against a live server, which is the honest limit on this row". It was
 * reasoned from the route table (no route exports a TRACE handler) rather than observed, and
 * reasoning about a method that never reaches application code is reasoning about the runtime, not
 * about us. This sends one.
 *
 * WHY IT RUNS ITS OWN SERVER, and it is not the same reason as check 3's. That one needed a
 * private log and a private rate limiter. This one needs to BREAK the instance halfway through:
 * the only way to observe the shape of a 500 is to cause one, and causing one on the suite's
 * shared server would take every later spec down with it. It is also the SHIPPED artifact
 * (`node build/index.js`, adapter-node) rather than `vite preview`, which matters here more than
 * usual: `vite preview` is a different HTTP server with a different static handler and a different
 * method surface, so a TRACE or a directory-listing result measured against it would be a fact
 * about Vite. The same reason check 1's e2e half exists.
 *
 * HOW THE 500 IS CAUSED, stated plainly because a simulated failure is worth exactly what its
 * fidelity is worth. After the healthy probes are captured, the `User` table is DROPPED from this
 * instance's private database. The next request to `/login` then throws a genuine
 * `PrismaClientKnownRequestError` deep inside the load function, which travels the real
 * `handleError` path and produces the real response. What is simulated is the CAUSE; the error
 * path, the renderer and the response are the application's own. Two response shapes come out of
 * it and both are checked, because they are produced by different code: a rendered HTML error page
 * for a GET, and SvelteKit's JSON `ActionResult` for a form action.
 *
 * An earlier attempt booted the server against an UNMIGRATED database instead, which is tidier and
 * does not work: `ensureNameKeysBackfilled` runs in the `init` hook and counts categories, so the
 * process dies at startup with the full Prisma stack on stderr and there is no server to ask. The
 * break has to land after boot.
 *
 * THE CALIBRATIONS, and there are two shapes of them because this file makes two shapes of claim.
 *
 * For the ABSENCE of internals in an error body, an empty search is the failure mode, and it can
 * be empty for two entirely different reasons. So both are closed separately:
 *
 *  1. THE FAILURE WAS GENUINE AND INTERNAL. Every token in `INTERNAL_TOKENS` is asserted PRESENT
 *     in the server's own stderr. Without this, "no stack in the body" is equally consistent with
 *     "nothing went wrong", and a probe that quietly stopped causing a 500 would report the
 *     strongest possible result.
 *  2. THE BODY IS A HAYSTACK THE SEARCH CAN READ. The generic message is asserted PRESENT in each
 *     body before anything is asserted absent from it. Without this, searching an empty string, a
 *     failed request or an undefined variable all return the same clean answer.
 *
 * Those two are the whole design: the same six tokens are proven present on one side of the
 * boundary and proven absent on the other, in the same run, by the same search. That is what makes
 * the absence mean "suppressed" rather than "never happened".
 *
 * For the ABSENCE of an endpoint, the failure mode is that everything 404s because nothing is
 * being reached at all. So `/login` and `/robots.txt` ride INSIDE the same status map as the
 * probed paths, one for the router and one for the static layer, rather than sitting in a separate
 * test that could pass while the battery below it was vacuous.
 *
 * THE HARNESS HAZARD THAT NEARLY WROTE THE TRACE CHECK FOR US, measured before the check existed.
 * `fetch('...', { method: 'TRACE' })` does not send anything: the Fetch standard lists CONNECT,
 * TRACE and TRACK as forbidden methods, and undici throws `TypeError: 'TRACE' HTTP method is
 * unsupported.` before opening a socket. A check written the obvious way, with the call in a
 * try/catch, would report "TRACE is refused" on every run, including against a server that echoed
 * it happily, because the refusal is the CLIENT's. The same family as the `echo` that manufactured
 * the XSS string it was searching for. Every method probe here goes through `node:http`, which
 * sends whatever verb it is given, and the GET control proves the socket, the headers and the body
 * capture all work through that same path.
 *
 * THE BREAK MATRIX, nine breaks against fourteen tests, read per test rather than per suite.
 * Baseline 14/14. Every break turns exactly the intended test red; the informative part is the
 * three rows where something stayed GREEN that a reader would expect to have been hurt.
 *
 *  - `no failure caused` (the instance is never broken, so every response is healthy):
 *    calibrations 1 and 2 red, and BOTH LEAK TESTS GREEN over a 200. They cannot tell "no stack in
 *    the body" from "no error". That is the vacuous pass, observed rather than argued.
 *  - `handleError returns the stack` (the real regression, since this application exports no
 *    handleError and the generic body is SvelteKit's default): all four red. Note calibration 1
 *    goes red too, and correctly: a custom hook REPLACES the framework's own logging, so the
 *    internals leave the response and leave stderr at the same time.
 *  - `error-phase stderr listener dropped`: calibration 1 red, ALL THREE OTHERS GREEN. The leak
 *    tests pass over a capture that is half empty, which is exactly what check 3 measured on its
 *    own capture. Calibration 1 is the only thing in this file that can see it.
 *  - `the searcher ignores its argument` (`leakedTokens` searches the empty string): only the
 *    searcher's own test red. BOTH LEAK TESTS GREEN, AND CALIBRATION 2 GREEN, because calibration
 *    2 reads the captured bodies directly and never passes through the function. Without that one
 *    test this break is all green, which is a check that has stopped checking and says so nowhere.
 *  - `directory lists`, `TRACE echoes`, `runtime NODE_ENV dropped`, `dev-only token renamed
 *    upstream`, `nothing is reached at all`: one red each, on their own test, nowhere else.
 */

const PORT = 4177;
const BASE_URL = `http://localhost:${PORT}`;
const DB_DIR = path.resolve('e2e/.data/errshape');
const DATABASE_URL = 'file:./e2e/.data/errshape/errshape.sqlite';

/**
 * Values this instance is configured with, held so the error bodies can be searched for them.
 *
 * `v5.0.0-16.5.1` names "secret keys, and tokens" alongside stack traces and queries. Unlike the
 * six tokens below, these are NOT proven present on stderr, because nothing logs them and that is
 * the point of check 3. They are carried by the same search whose ability to read the body is
 * proven by calibration 2, which is the honest statement of what covers them.
 */
const CONFIGURED_SECRETS = {
	bootstrapToken: 'bp-errshape-bootstrap-4a17c9',
	rateLimitSecret: 'beef'.repeat(16),
	totpKey: 'f00d'.repeat(16)
};

const SERVER_ENV = {
	DATABASE_URL,
	PORT: String(PORT),
	// See log-secret-scan.spec.ts: without ORIGIN, adapter-node refuses every form POST with 403,
	// which would silently turn the action-shape assertion below into a test about CSRF.
	ORIGIN: BASE_URL,
	PUBLIC_INSTANCE: 'false',
	REGISTRATION_MODE: 'admin_only',
	PASSWORD_HASH_COST: '4',
	BOOTSTRAP_TOKEN: CONFIGURED_SECRETS.bootstrapToken,
	RATE_LIMIT_HASH_SECRET: CONFIGURED_SECRETS.rateLimitSecret,
	TOTP_ENCRYPTION_KEY: CONFIGURED_SECRETS.totpKey,
	LLM_ENABLED: 'false'
};

/**
 * Internal system data that the failure genuinely produces, one entry per class named by
 * `v5.0.0-16.5.1`.
 *
 * Every one of these is asserted PRESENT in the server's stderr and ABSENT from both response
 * bodies. Chosen to be stable across ordinary refactoring: a schema model name, an ORM call
 * prefix, an error class, a dependency path, the bundle layout and a stack-frame marker. An
 * internal FUNCTION name was in the first draft and taken out, because it would be renamed by
 * unrelated work and the resulting red would say nothing about the boundary.
 */
const INTERNAL_TOKENS = {
	databaseTable: 'main.User',
	query: 'prisma.user.',
	errorClass: 'PrismaClientKnownRequestError',
	dependencyPath: 'node_modules/@prisma/client',
	bundleLayout: 'build/server/chunks',
	stackFrame: 'at async'
};

/** Every path a scanner tries first, plus two controls that must NOT 404. */
const ENDPOINT_PROBES: Record<string, number> = {
	// The controls, deliberately inside the same map: an app route and a static file. A wrong port,
	// a wrong base or a server answering 404 to everything moves these, and the battery below can
	// then never report a clean sweep it has not earned.
	'/login': 200,
	'/robots.txt': 200,
	// Monitoring.
	'/metrics': 404,
	'/health': 404,
	'/healthz': 404,
	'/readyz': 404,
	'/status': 404,
	'/server-status': 404,
	'/actuator': 404,
	'/actuator/health': 404,
	// Documentation.
	'/swagger': 404,
	'/swagger-ui': 404,
	'/swagger-ui.html': 404,
	'/api-docs': 404,
	'/openapi.json': 404,
	'/graphql': 404,
	// Debug and configuration surfaces, which are the same disclosure by another name.
	'/debug': 404,
	'/.env': 404,
	'/.git/config': 404,
	'/config.json': 404
};

/** The static directory whose listing must not be served, and one real file inside it. */
const STATIC_DIR_URL = '/_app/immutable/nodes/';
const STATIC_DIR_ON_DISK = path.join('build', 'client', '_app', 'immutable', 'nodes');

interface RawResponse {
	status: number;
	contentType: string;
	body: string;
}

let server: ChildProcessByStdio<null, Readable, Readable>;
let serverStderr = '';
/** Everything captured from the moment the database is broken, so the tokens are this run's. */
let errorPhaseStderr = '';

const endpointStatuses: Record<string, number> = {};
let staticAssetResponse: RawResponse;
let staticDirectoryResponse: RawResponse;
let staticFilenames: string[] = [];
const methodResponses: Record<string, RawResponse> = {};
let renderedErrorPage: RawResponse;
let actionErrorResult: RawResponse;

/** The header value a TRACE echo would hand straight back. Nothing else in the app produces it. */
const TRACE_CANARY = 'errshape-trace-canary-5b81d4';

function rawRequest(
	method: string,
	requestPath: string,
	options: { headers?: Record<string, string>; body?: string; port?: number } = {}
): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = { ...options.headers };
		if (options.body !== undefined) {
			headers['content-type'] = 'application/x-www-form-urlencoded';
			headers['content-length'] = String(Buffer.byteLength(options.body));
		}
		const request = httpRequest(
			{ host: 'localhost', port: options.port ?? PORT, path: requestPath, method, headers },
			(response) => {
				let body = '';
				response.setEncoding('utf8');
				response.on('data', (chunk: string) => (body += chunk));
				response.on('end', () =>
					resolve({
						status: response.statusCode ?? 0,
						contentType: response.headers['content-type'] ?? '',
						body
					})
				);
			}
		);
		request.on('error', reject);
		if (options.body !== undefined) request.write(options.body);
		request.end();
	});
}

test.beforeAll(async () => {
	if (!existsSync('build/index.js')) {
		throw new Error(
			'error-shape-and-endpoints: build/index.js is absent, so there is no artifact to boot'
		);
	}

	rmSync(DB_DIR, { recursive: true, force: true });
	mkdirSync(DB_DIR, { recursive: true });
	execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
		env: { ...process.env, DATABASE_URL },
		stdio: 'ignore'
	});

	server = spawn('node', ['build/index.js'], {
		env: { ...process.env, ...SERVER_ENV },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	server.stdout.on('data', (chunk: Buffer) => (serverStderr += chunk.toString()));
	server.stderr.on('data', (chunk: Buffer) => (serverStderr += chunk.toString()));

	await waitForServer();

	// ---- healthy phase: everything that needs a working instance ----

	for (const probe of Object.keys(ENDPOINT_PROBES)) {
		endpointStatuses[probe] = (await rawRequest('GET', probe)).status;
	}

	staticFilenames = readdirSync(STATIC_DIR_ON_DISK).filter((name) => name.endsWith('.js'));
	staticAssetResponse = await rawRequest('GET', `${STATIC_DIR_URL}${staticFilenames[0]}`);
	staticDirectoryResponse = await rawRequest('GET', STATIC_DIR_URL);

	for (const method of ['GET', 'TRACE', 'TRACK', 'OPTIONS', 'PUT', 'DELETE', 'PATCH']) {
		methodResponses[method] = await rawRequest(method, '/login', {
			headers: { 'X-Errshape-Probe': TRACE_CANARY }
		});
	}

	// ---- break the instance ----

	// Everything below this line is captured separately, so the tokens asserted present on stderr
	// are this failure's rather than anything the boot might have written.
	errorPhaseStderr = '';
	const collectErrorPhase = (chunk: Buffer) => (errorPhaseStderr += chunk.toString());
	server.stdout.on('data', collectErrorPhase);
	server.stderr.on('data', collectErrorPhase);

	// `db execute` refuses a DROP of a table that is not there, so a break that silently did
	// nothing cannot pass as a break. The same reason every scripted break-check in this repo
	// asserts its own patch applied before writing.
	execFileSync('npx', ['prisma', 'db', 'execute', '--stdin'], {
		env: { ...process.env, DATABASE_URL },
		input: 'DROP TABLE "User";',
		stdio: ['pipe', 'ignore', 'pipe']
	});

	// ---- error phase: the two response shapes an unexpected failure produces ----

	renderedErrorPage = await rawRequest('GET', '/login');
	actionErrorResult = await rawRequest('POST', '/login', {
		headers: { Origin: BASE_URL, 'x-sveltekit-action': 'true' },
		body: 'email=nobody%40budgetpilot.test&password=irrelevant-9f2b'
	});
});

test.afterAll(() => {
	server?.kill('SIGTERM');
	rmSync(DB_DIR, { recursive: true, force: true });
});

async function waitForServer(timeoutMs = 30_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			if ((await rawRequest('GET', '/login')).status === 200) return;
		} catch {
			// Not accepting connections yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(
		`error-shape-and-endpoints: server never became reachable at ${BASE_URL}\n${serverStderr}`
	);
}

test.describe('v5.0.0-16.5.1, v5.0.0-13.4.2: an unexpected error discloses nothing', () => {
	test('calibration: the failure was genuine, and every internal token IS on the server side', () => {
		// The half that makes every absence below mean something. If this is red, the bodies are
		// clean because nothing broke, which is the strongest-looking result this file can produce
		// and the only worthless one.
		expect(renderedErrorPage.status).toBe(500);
		expect(actionErrorResult.status).toBe(500);

		const missing = Object.entries(INTERNAL_TOKENS)
			.filter(([, token]) => !errorPhaseStderr.includes(token))
			.map(([name]) => name);

		expect(
			missing,
			`internal detail the server never produced, so its absence from the body proves nothing: ${missing.join(', ')}`
		).toEqual([]);
	});

	test('calibration: each error body is a haystack the search can actually read', () => {
		// Searching an empty string for a stack trace succeeds every time. Both bodies must be
		// readable and must contain the one string they are supposed to contain.
		expect(actionErrorResult.body).toBe('{"type":"error","error":{"message":"Internal Error"}}');
		expect(renderedErrorPage.contentType).toContain('text/html');
		expect(renderedErrorPage.body.length).toBeGreaterThan(500);
		expect(renderedErrorPage.body).toContain('Internal Error');
	});

	test('the JSON action result carries no stack, query, path or key', () => {
		const leaked = leakedTokens(actionErrorResult.body);
		expect(leaked, `internals in the action result: ${leaked.join(', ')}`).toEqual([]);
	});

	// A separate test rather than a loop over both, because the rendered page is produced by a
	// different code path from the action result: SvelteKit serialises the error into the page's
	// hydration payload as well as rendering it, and that payload is where a richer error object
	// would show up first.
	test('the rendered 500 page carries no stack, query, path or key', () => {
		const leaked = leakedTokens(renderedErrorPage.body);
		expect(leaked, `internals in the rendered error page: ${leaked.join(', ')}`).toEqual([]);
	});

	// v5.0.0-13.4.2's mechanism rather than its symptom. The verdict says SvelteKit strips its
	// dev-only branches at build time and names `fix_stack_trace`, the path that rewrites a stack
	// against the source map before it is attached to the error. Asserting it is gone from the
	// bundle measures the stripping; asserting it is present in the installed framework is what
	// stops this becoming a search for a string that no longer exists anywhere, which would pass
	// forever and mean nothing.
	test('v5.0.0-13.4.2: the production bundle has no dev-only stack rewriting, and the token is one that still exists', () => {
		const kitSource = readFileSync(
			path.join('node_modules', '@sveltejs', 'kit', 'src', 'runtime', 'server', 'utils.js'),
			'utf8'
		);
		expect(kitSource).toContain('fix_stack_trace');

		const bundle = readdirSync(path.join('build', 'server'), { recursive: true })
			.map((entry) => path.join('build', 'server', String(entry)))
			.filter((entry) => entry.endsWith('.js'));
		expect(bundle.length).toBeGreaterThan(10);

		const offenders = bundle.filter((entry) =>
			readFileSync(entry, 'utf8').includes('fix_stack_trace')
		);
		expect(offenders, `dev-only stack rewriting in the bundle: ${offenders.join(', ')}`).toEqual(
			[]
		);
	});

	// The image half, and the narrower claim of the two. This reads the Dockerfile rather than the
	// built image, so it cannot see a `docker run -e NODE_ENV=development`; what it can see is the
	// line being dropped, which is the regression that would ship.
	//
	// Scoped to the RUNTIME stage on purpose. `ENV NODE_ENV=production` appears twice in this
	// Dockerfile and the first one is in `prod-deps`, a build stage that never ships. A plain grep
	// for the string would stay green with the shipped one deleted, which is precisely the
	// vacuous-pass shape this phase keeps finding.
	test('v5.0.0-13.4.2: the stage that actually ships sets NODE_ENV=production', () => {
		const stages = readFileSync('Dockerfile', 'utf8').split(/^FROM .*$/m);
		expect(stages.length).toBeGreaterThan(2);

		const shipped = stages[stages.length - 1];
		expect(shipped).toContain('CMD');
		expect(shipped).toMatch(/^ENV NODE_ENV=production$/m);
	});
});

/** Every internal token, and every configured secret, that made it into a response body. */
function leakedTokens(body: string): string[] {
	return [...Object.entries(INTERNAL_TOKENS), ...Object.entries(CONFIGURED_SECRETS)]
		.filter(([, value]) => body.includes(value))
		.map(([name]) => name);
}

// The searcher's own test, and the third calibration this file needs rather than a nicety.
//
// Calibration 2 proves the CAPTURE is a readable haystack; it reads `renderedErrorPage.body`
// directly and therefore says nothing about what `leakedTokens` does with the argument it is
// handed. Measured: rewriting `leakedTokens` to search the empty string leaves both leak tests
// green AND leaves calibration 2 green, because they observe different things. This closes that,
// by handing the function a body that contains every value and requiring it to name all of them.
test.describe('the leak search itself', () => {
	test('finds every token and secret when they ARE present', () => {
		const everything = [
			...Object.values(INTERNAL_TOKENS),
			...Object.values(CONFIGURED_SECRETS)
		].join(' | ');

		const expected = [...Object.keys(INTERNAL_TOKENS), ...Object.keys(CONFIGURED_SECRETS)];
		expect(leakedTokens(everything).sort()).toEqual(expected.sort());
	});
});

test.describe('v5.0.0-13.4.3: no directory listing', () => {
	test('calibration: the static root is genuinely served, so a refusal is a refusal', () => {
		// Without this, "the directory does not enumerate" is equally true of a static root that is
		// not mounted at all, and the check would survive the whole static layer being removed.
		expect(staticFilenames.length).toBeGreaterThan(5);
		expect(staticAssetResponse.status).toBe(200);
		expect(staticAssetResponse.body.length).toBeGreaterThan(0);
	});

	test('the directory itself enumerates nothing', () => {
		expect(staticDirectoryResponse.status).not.toBe(200);

		// Sharper than the status, and the reason this is not one assertion: a 200 carrying an index
		// is the obvious failure, but so is any response that names what is in there. The filenames
		// are read off disk, so this compares the response against the actual contents rather than
		// against a guess at what a listing looks like.
		const named = staticFilenames.filter((name) => staticDirectoryResponse.body.includes(name));
		expect(named, `filenames disclosed by the directory response: ${named.join(', ')}`).toEqual([]);
	});
});

test.describe('v5.0.0-13.4.4: TRACE is not supported', () => {
	test('calibration: the raw client reaches the app and its headers and bodies come back', () => {
		// The GET goes through the identical node:http path, with the identical canary header, as
		// every method below. A TRACE result means nothing without it: an unreachable server refuses
		// TRACE too.
		expect(methodResponses.GET.status).toBe(200);
		expect(methodResponses.GET.body.length).toBeGreaterThan(0);
	});

	test('TRACE and TRACK are refused and echo nothing back', () => {
		for (const method of ['TRACE', 'TRACK']) {
			const response = methodResponses[method];
			expect(response.status, `${method} was answered with 200`).not.toBe(200);
			// The disclosure this requirement is actually about: a TRACE echo hands the request's own
			// headers back, which is how Cross-Site Tracing reads a cookie the script cannot.
			expect(response.body, `${method} echoed a request header`).not.toContain(TRACE_CANARY);
		}
	});

	// "Feed it an input you KNOW is vulnerable and confirm it reports it, before trusting a clean
	// run." The assertion above is an absence, and reading it says it would fail on an echo; this
	// runs it against one. A twenty-line server that echoes a TRACE the way a misconfigured proxy
	// does is stood up on a spare port, and the SAME predicate is pointed at it.
	//
	// It costs one socket and it closes the one thing inspection cannot: that `rawRequest` sends
	// the canary header at all. A client that silently dropped custom headers would make the real
	// assertion pass for a reason that has nothing to do with the server.
	test('calibration: the same predicate reports a server that DOES echo TRACE', async () => {
		const echoPort = 4178;
		const echo = createServer((request, response) => {
			const headerLines = Object.entries(request.headers)
				.map(([name, value]) => `${name}: ${value}`)
				.join('\r\n');
			response.writeHead(200, { 'content-type': 'message/http' });
			response.end(`TRACE ${request.url} HTTP/1.1\r\n${headerLines}`);
		});
		await new Promise<void>((resolve) => echo.listen(echoPort, '127.0.0.1', resolve));

		try {
			const echoed = await rawRequest('TRACE', '/login', {
				port: echoPort,
				headers: { 'X-Errshape-Probe': TRACE_CANARY }
			});
			// Both halves of the real assertion, inverted. If either of these is not what a
			// vulnerable server looks like, the real assertion is aimed at the wrong thing.
			expect(echoed.status).toBe(200);
			expect(echoed.body).toContain(TRACE_CANARY);
		} finally {
			await new Promise<void>((resolve) => echo.close(() => resolve()));
		}
	});

	test('the remaining method surface is the one this application declares', () => {
		// Pinned rather than asserted loosely: these are what SvelteKit answers for a route that
		// exports GET and form actions, and a change here means a route gained a verb.
		expect({
			OPTIONS: methodResponses.OPTIONS.status,
			PUT: methodResponses.PUT.status,
			DELETE: methodResponses.DELETE.status,
			PATCH: methodResponses.PATCH.status
		}).toEqual({ OPTIONS: 204, PUT: 405, DELETE: 405, PATCH: 405 });
	});
});

test.describe('v5.0.0-13.4.5: no documentation or monitoring endpoint', () => {
	test('every documentation, monitoring and debug path is absent, and the controls are not', () => {
		// One assertion on purpose. The two 200s ride with the eighteen 404s, so a run in which
		// nothing was reached cannot report a clean sweep: it moves the controls first.
		expect(endpointStatuses).toEqual(ENDPOINT_PROBES);
	});
});
