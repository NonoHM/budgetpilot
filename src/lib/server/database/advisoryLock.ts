import { createHash } from 'node:crypto';
import { createPrismaClient } from './client.ts';
import { resolveDatabaseProvider, type DatabaseEnv } from './provider.ts';

/**
 * Serializes the boot-time backfills across application instances.
 *
 * `hooks.server.ts`'s `init` runs two one-shot data migrations: the name-key merge and the
 * dedupe-key hashing. Both read a plan and then write it, and both are global rather than
 * scoped to one user. On SQLite that is safe for free, because SQLite admits one writer. On a
 * server engine nothing prevents two application containers from pointing at the same database,
 * which `docs/database-providers.md` explicitly supports: both would enter `init` at once, both
 * would compute the same plan, and both would apply it. The likely outcome is a unique-key
 * violation on whichever loses, at startup, on the one code path whose failure is fatal by
 * design. The unlikely outcomes are worse and involve financial data.
 *
 * So the writes happen under a database-level lock, and the callers re-check whether there is
 * anything left to do once they hold it. The second instance then finds the work already done
 * and starts normally.
 *
 * Two engines, two mechanisms, both advisory (they lock a name, not a row, so they cost nothing
 * and block nothing else the app does):
 *
 * - PostgreSQL's `pg_advisory_lock` family is scoped to one database, so the lock name is just
 *   the backfill's.
 * - MySQL's `GET_LOCK` is scoped to the whole server, so the name has to carry the database as
 *   well. Two BudgetPilot databases on one MariaDB would otherwise queue behind each other for
 *   no reason.
 *
 * Both are session-scoped, which is what makes the dedicated client below load-bearing.
 */

/**
 * How long to wait for the other instance before giving up.
 *
 * Generous, because the thing being waited for is a data migration over an operator's whole
 * history, and every second spent waiting is a second the work is actually progressing
 * elsewhere. Giving up raises, rather than proceeding without the lock: the app must not serve
 * requests against half-merged categories, and a container that exits gets restarted and tries
 * again, by which time the winner has usually finished.
 */
const LOCK_WAIT_SECONDS = 600;

/** How often to re-try PostgreSQL's non-blocking acquire. MySQL blocks natively instead. */
const POLL_INTERVAL_MS = 2000;

/**
 * How often to touch the lock connection while the work it protects is running.
 *
 * A lock taken and then left alone is a lock that quietly goes away. Two mechanisms do it, and
 * the first was observed rather than reasoned about: `pg`'s pool closes a connection that has
 * been idle for ten seconds, and PostgreSQL releases a session's advisory locks when the session
 * ends, so the lock vanished between the eighth and thirteenth second of the backfill it was
 * protecting. That defeats the whole point precisely for the long backfills that need it.
 *
 * `singleConnection` on the adapter closes that one. This closes the other: an operator's server
 * may set `idle_session_timeout` (PostgreSQL) or a short `wait_timeout` (MySQL), which no client
 * setting can override. A trivial query every few seconds keeps the session alive, and with a
 * one-connection pool it is provably the session holding the lock.
 */
const KEEP_ALIVE_INTERVAL_MS = 5000;

/**
 * How often to say that the wait is still going on.
 *
 * Waiting silently for up to ten minutes looks identical to a hang. One line every half minute
 * costs nothing and turns `docker compose logs` into an explanation.
 */
const WAIT_LOG_INTERVAL_MS = 30_000;

export interface BootLockDeps {
	env?: DatabaseEnv;
	/** Injected by the tests. Production always builds a real client. */
	createClient?: typeof createPrismaClient;
	/** Injected by the tests, which cannot afford to wait out the real values. */
	waitSeconds?: number;
	pollIntervalMs?: number;
	keepAliveIntervalMs?: number;
}

/**
 * Runs `work` while holding the named lock. Returns whatever `work` returns.
 *
 * SQLite skips the whole mechanism, including the connection: it has neither advisory-lock
 * function, and one writer at a time is the guarantee this exists to recreate.
 */
export async function withBootBackfillLock<T>(
	name: string,
	work: () => Promise<T>,
	deps: BootLockDeps = {}
): Promise<T> {
	const env = deps.env ?? process.env;
	const provider = resolveDatabaseProvider(env);
	if (provider === 'sqlite') return work();

	const waitSeconds = deps.waitSeconds ?? LOCK_WAIT_SECONDS;
	const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;

	// A client of its own, not the application singleton, and pinned to one connection. Both
	// mechanisms are held by a *session*, and a Prisma client hands each query whichever pooled
	// connection is free, so on the singleton a lock could be taken on one connection and
	// released against another. One connection that nothing else ever touches makes the session
	// a thing this module owns: the keep-alive below reaches it, and the disconnect in the outer
	// `finally` ends it, which is what actually guarantees the lock is released.
	const client = (deps.createClient ?? createPrismaClient)(env, { singleConnection: true });

	try {
		if (provider === 'postgresql') {
			await acquirePostgresLock(client, name, waitSeconds, pollIntervalMs);
		} else {
			await acquireMysqlLock(client, name, waitSeconds, pollIntervalMs);
		}

		// Started only once the lock is held, and stopped before the release. See
		// KEEP_ALIVE_INTERVAL_MS: a lock nobody touches is a lock that goes away on its own.
		const keepAlive = startKeepAlive(client, deps.keepAliveIntervalMs ?? KEEP_ALIVE_INTERVAL_MS);
		try {
			return await work();
		} finally {
			clearInterval(keepAlive);
			// Best effort. The disconnect below is the guarantee; this just gives the lock back
			// a moment earlier, and on a one-connection pool it does reach the right session.
			await releaseQuietly(client, provider, name);
		}
	} finally {
		await client.$disconnect();
	}
}

/**
 * Touches the lock connection on a timer, so neither the client pool nor the server decides the
 * session has been idle long enough to close.
 *
 * Failures are ignored on purpose: this is a keep-alive, not a health check, and a connection
 * that has genuinely gone will surface as the release or the disconnect failing. `unref` so a
 * pending tick can never be the reason the process stays alive.
 */
function startKeepAlive(client: LockClient, intervalMs: number): ReturnType<typeof setInterval> {
	const timer = setInterval(() => {
		void Promise.resolve(client.$queryRaw`SELECT 1`).catch(() => {});
	}, intervalMs);
	timer.unref?.();
	return timer;
}

/**
 * Try, wait, try again, until the deadline. One shape for both engines.
 *
 * Neither blocking form is used, and for the same reason on both: `pg_advisory_lock` waits
 * forever, and a single long `GET_LOCK` waits silently. Either turns a stuck peer into a
 * container that is running, not listening, and saying nothing. Polling costs one trivial query
 * every couple of seconds, lets the wait be reported while it happens, and produces a real error
 * at the deadline.
 */
async function pollForLock(
	name: string,
	waitSeconds: number,
	pollIntervalMs: number,
	tryAcquire: () => Promise<boolean>
): Promise<void> {
	const started = Date.now();
	const deadline = started + waitSeconds * 1000;
	let nextLogAt = started + WAIT_LOG_INTERVAL_MS;

	for (;;) {
		if (await tryAcquire()) return;
		if (Date.now() >= deadline) throw lockTimeout(name, waitSeconds);

		if (Date.now() >= nextLogAt) {
			console.log(
				`[${name}] waiting for another instance to finish the one-time backfill ` +
					`(${Math.round((Date.now() - started) / 1000)}s so far)`
			);
			nextLogAt = Date.now() + WAIT_LOG_INTERVAL_MS;
		}

		await sleep(pollIntervalMs);
	}
}

/**
 * PostgreSQL's non-blocking acquire.
 *
 * The two 32-bit keys come from the lock's name, so the numbers are derived and never typed in
 * anywhere. Explicit `::int4` casts because the two-argument form is `(int4, int4)` and Prisma
 * is free to send a JavaScript number as a wider integer.
 */
async function acquirePostgresLock(
	client: LockClient,
	name: string,
	waitSeconds: number,
	pollIntervalMs: number
): Promise<void> {
	const [high, low] = postgresLockKeys(name);

	await pollForLock(name, waitSeconds, pollIntervalMs, async () => {
		const rows =
			await client.$queryRaw`SELECT pg_try_advisory_lock(${high}::int4, ${low}::int4) AS locked`;
		return readLockResult(rows) === true;
	});
}

/**
 * MySQL and MariaDB's acquire, with `GET_LOCK`'s own timeout set to 0 so it is a try rather than
 * a wait. The waiting is the poll loop's job, the same as on PostgreSQL.
 *
 * `GET_LOCK` answers 1 when the lock was taken, 0 when it was not, and NULL on an error such as
 * the server killing the statement. Only 1 may proceed.
 */
async function acquireMysqlLock(
	client: LockClient,
	name: string,
	waitSeconds: number,
	pollIntervalMs: number
): Promise<void> {
	const lockName = mysqlLockName(await readDatabaseName(client), name);

	await pollForLock(name, waitSeconds, pollIntervalMs, async () => {
		const rows = await client.$queryRaw`SELECT GET_LOCK(${lockName}, 0) AS locked`;
		return readLockResult(rows) === true;
	});
}

async function releaseQuietly(
	client: LockClient,
	provider: 'postgresql' | 'mysql',
	name: string
): Promise<void> {
	try {
		if (provider === 'postgresql') {
			const [high, low] = postgresLockKeys(name);
			await client.$queryRaw`SELECT pg_advisory_unlock(${high}::int4, ${low}::int4) AS released`;
			return;
		}
		const lockName = mysqlLockName(await readDatabaseName(client), name);
		await client.$queryRaw`SELECT RELEASE_LOCK(${lockName}) AS released`;
	} catch {
		// Nothing to do and nothing worth logging: the disconnect that follows releases the lock
		// whatever happened here, and a failure at this point is a connection that is already
		// going away.
	}
}

/** The database this connection is on, used to scope MySQL's server-wide lock namespace. */
async function readDatabaseName(client: LockClient): Promise<string> {
	const rows = await client.$queryRaw`SELECT DATABASE() AS name`;
	const value = firstColumn(rows, 'name');
	return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}

/**
 * Two signed 32-bit integers derived from the lock's name.
 *
 * A hash rather than hand-picked constants, so adding a lock later cannot collide with an
 * existing one by someone reusing a number. Signed because that is what `int4` is, and an
 * unsigned value above 2^31 would not fit.
 */
export function postgresLockKeys(name: string): [number, number] {
	const digest = createHash('sha256').update(`budgetpilot:${name}`).digest();
	return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * The `GET_LOCK` name, scoped to one database and kept inside MySQL's 64-character limit.
 *
 * Hashed rather than assembled from readable parts: a database name is operator-supplied and of
 * no bounded length, so building `budgetpilot:<database>:<lock>` would silently truncate on a
 * long one and merge two locks that must stay apart.
 */
export function mysqlLockName(database: string, name: string): string {
	const digest = createHash('sha256').update(`budgetpilot:${database}:${name}`).digest('hex');
	return `bp:${digest.slice(0, 32)}`;
}

function lockTimeout(name: string, waitSeconds: number): Error {
	return new Error(
		`Timed out after ${waitSeconds}s waiting for the "${name}" startup lock. ` +
			'Another BudgetPilot instance on this database is most likely still running the ' +
			'one-time backfill. This instance is stopping rather than writing alongside it; it ' +
			'will retry when it restarts.'
	);
}

/** Reads the single boolean-ish cell every acquire query returns, across both drivers. */
function readLockResult(rows: unknown): boolean | null {
	const value = firstColumn(rows, 'locked');
	if (value === true || value === 1 || value === 1n || value === '1') return true;
	if (value === false || value === 0 || value === 0n || value === '0') return false;
	return null;
}

function firstColumn(rows: unknown, column: string): unknown {
	if (!Array.isArray(rows) || rows.length === 0) return undefined;
	const row = rows[0];
	if (typeof row !== 'object' || row === null) return undefined;
	return (row as Record<string, unknown>)[column];
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Only the one method this module calls, so a test double stays a few lines. */
type LockClient = {
	$queryRaw: (template: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
	$disconnect: () => Promise<unknown>;
};
