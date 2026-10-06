import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from './generated/sqlite/client';
import { SerializedSqliteAdapterFactory } from './serializedSqliteAdapter';

/**
 * The decorator against the REAL better-sqlite3 driver, driven the way Prisma's client 7.10.0
 * drives an adapter: `startTransaction`, statements on the transaction, then one of three closes:
 *
 * - success: the COMMIT statement through `executeRaw`, then `commit()`;
 * - rollback: the ROLLBACK statement through `executeRaw`, then `rollback()`;
 * - FAILED COMMIT: the COMMIT statement rejects (SQLITE_BUSY, an I/O error), and Prisma calls
 *   `rollback()` WITHOUT sending ROLLBACK, so the transaction is still open on the connection.
 *
 * The first two run on an in-memory database. The third needs a FILE database, because BUSY needs
 * a second connection holding a lock, and that block also drives a real `PrismaClient` so the
 * sequence is Prisma's own rather than a helper's.
 *
 * In the unit suite on purpose. `transactionIsolation.db-smoke.ts` proves the property through the
 * full client, but CI's db-matrix runs db-smoke on PostgreSQL and MariaDB only (#891), and SQLite is
 * the one engine with the defect (#889). This file is the gate CI runs on SQLite.
 *
 * Each test opens its own connection, so a hold leaked by one cannot stall the next.
 */

type Connection = Awaited<ReturnType<SerializedSqliteAdapterFactory['connect']>>;

const statement = (sql: string) => ({ sql, args: [], argTypes: [] });

/** How long a query that is NOT held back takes to settle here, with a wide margin: in-memory. */
const SETTLES_MS = 50;
/** A bounded wait for "the hold was released", so a leaked hold reads as a reason, not a hang. */
const RELEASED_WITHIN_MS = 1_000;

async function stateAfter(work: Promise<unknown>, ms: number): Promise<'settled' | 'pending'> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const pending = new Promise<'pending'>((resolve) => {
		timer = setTimeout(() => resolve('pending'), ms);
	});
	try {
		return await Promise.race([
			work.then(
				() => 'settled' as const,
				() => 'settled' as const
			),
			pending
		]);
	} finally {
		clearTimeout(timer);
	}
}

let connection: Connection;

async function value(id: number): Promise<number> {
	const result = await connection.queryRaw(statement(`SELECT v FROM t WHERE id = ${id}`));
	return Number(result.rows[0][0]);
}

async function rollBack(tx: Awaited<ReturnType<Connection['startTransaction']>>): Promise<void> {
	await tx.executeRaw(statement('ROLLBACK'));
	await tx.rollback();
}

async function commit(tx: Awaited<ReturnType<Connection['startTransaction']>>): Promise<void> {
	await tx.executeRaw(statement('COMMIT'));
	await tx.commit();
}

beforeEach(async () => {
	connection = await new SerializedSqliteAdapterFactory(
		new PrismaBetterSqlite3({ url: ':memory:' })
	).connect();
	await connection.executeScript(
		'CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL); INSERT INTO t VALUES (1, 0), (2, 0);'
	);
});

afterEach(async () => {
	await connection.dispose();
});

describe('a base query issued while a transaction is open', () => {
	// Each of these separates « the query waited for the transaction » from « it ran on the shared
	// connection inside it ». One per base method, because each takes the lock separately.
	it('holds executeRaw until the transaction closes', async () => {
		expect.assertions(1);

		const tx = await connection.startTransaction();
		await tx.executeRaw(statement('UPDATE t SET v = 1 WHERE id = 1'));
		const outside = connection.executeRaw(statement('UPDATE t SET v = 1 WHERE id = 2'));

		expect(await stateAfter(outside, SETTLES_MS)).toBe('pending');
		await rollBack(tx);
		await outside;
	});

	it('holds queryRaw until the transaction closes', async () => {
		expect.assertions(1);

		const tx = await connection.startTransaction();
		const outside = connection.queryRaw(statement('SELECT v FROM t WHERE id = 1'));

		expect(await stateAfter(outside, SETTLES_MS)).toBe('pending');
		await rollBack(tx);
		await outside;
	});

	it('holds executeScript until the transaction closes', async () => {
		expect.assertions(1);

		const tx = await connection.startTransaction();
		const outside = connection.executeScript('UPDATE t SET v = 1 WHERE id = 2;');

		expect(await stateAfter(outside, SETTLES_MS)).toBe('pending');
		await rollBack(tx);
		await outside;
	});
});

describe('when that transaction rolls back', () => {
	it('keeps the outside write and undoes only the inside one', async () => {
		expect.assertions(1);

		// THE property of #889, as values: row 1 written inside and rolled back, row 2 written outside.
		const tx = await connection.startTransaction();
		await tx.executeRaw(statement('UPDATE t SET v = 1 WHERE id = 1'));
		const outside = connection.executeRaw(statement('UPDATE t SET v = 1 WHERE id = 2'));
		await stateAfter(outside, SETTLES_MS);
		await rollBack(tx);
		await outside;

		expect([await value(1), await value(2)]).toEqual([0, 1]);
	});

	it('lets an outside read see the committed value, never the uncommitted one', async () => {
		expect.assertions(1);

		const tx = await connection.startTransaction();
		await tx.executeRaw(statement('UPDATE t SET v = 7 WHERE id = 1'));
		const outside = connection.queryRaw(statement('SELECT v FROM t WHERE id = 1'));
		await stateAfter(outside, SETTLES_MS);
		await rollBack(tx);

		expect(Number((await outside).rows[0][0])).toBe(0);
	});
});

describe('the hold is released', () => {
	// Each separates « closing the transaction gave the connection back » from « every later query
	// on this connection waits forever ». Bounded, so a leak fails with a reason.
	it('on commit', async () => {
		expect.assertions(1);

		await commit(await connection.startTransaction());

		expect(await stateAfter(value(1), RELEASED_WITHIN_MS)).toBe('settled');
	});

	it('on rollback', async () => {
		expect.assertions(1);

		await rollBack(await connection.startTransaction());

		expect(await stateAfter(value(1), RELEASED_WITHIN_MS)).toBe('settled');
	});

	it('when startTransaction refuses an isolation level, since nothing will ever close it', async () => {
		expect.assertions(1);

		// The adapter refuses any isolation level but SERIALIZABLE after the decorator has taken its
		// hold, so this is a real failure through `startTransaction`, not a mock. It covers OUR
		// release only: the refusal comes before the adapter takes its own private mutex, so it cannot
		// show a BEGIN failure leaking that mutex. That case needs a transaction left open, which only
		// a failed COMMIT produced; see « when the COMMIT statement itself fails » below.
		await connection.startTransaction('READ COMMITTED').catch(() => undefined);

		expect(await stateAfter(value(1), RELEASED_WITHIN_MS)).toBe('settled');
	});

	it('and the failure is the adapter’s own refusal, passed through', async () => {
		expect.assertions(1);

		await expect(connection.startTransaction('READ COMMITTED')).rejects.toMatchObject({
			cause: { kind: 'InvalidIsolationLevel', level: 'READ COMMITTED' }
		});
	});
});

describe('a release that runs twice', () => {
	it('does not unlock the transaction that took the hold next', async () => {
		expect.assertions(1);

		// Separates a per-hold release (a second call is a no-op) from a shared one (a late second
		// close of the first transaction releases the SECOND transaction's hold, and an outside query
		// runs inside it). Prisma closes each transaction once today; this keeps a double close safe.
		const first = await connection.startTransaction();
		await rollBack(first);
		const second = await connection.startTransaction();
		await first.rollback();
		const outside = connection.executeRaw(statement('UPDATE t SET v = 1 WHERE id = 2'));

		expect(await stateAfter(outside, SETTLES_MS)).toBe('pending');
		await second.executeRaw(statement('ROLLBACK')).catch(() => undefined);
		await second.rollback();
		await outside;
	});

	it('and sends nothing, so it cannot end the transaction that took the hold next', async () => {
		expect.assertions(1);

		// `rollback()` sends its own ROLLBACK, on the ONE connection. Sent again by a late second
		// close of the first transaction, it would end whichever transaction holds the connection by
		// then, and that one's write would vanish. Separates « only the first close touches the
		// connection » from « every close does ».
		const first = await connection.startTransaction();
		await rollBack(first);
		const second = await connection.startTransaction();
		await second.executeRaw(statement('UPDATE t SET v = 1 WHERE id = 1'));
		await first.rollback();
		const seenBySecond = await second.queryRaw(statement('SELECT v FROM t WHERE id = 1'));
		await second.executeRaw(statement('ROLLBACK')).catch(() => undefined);
		await second.rollback();

		expect(Number(seenBySecond.rows[0][0])).toBe(1);
	});
});

describe('everything else is the adapter’s own', () => {
	it('names the same provider and adapter as the driver it wraps', async () => {
		expect.assertions(2);

		const driver = new PrismaBetterSqlite3({ url: ':memory:' });
		const factory = new SerializedSqliteAdapterFactory(driver);

		expect([factory.provider, factory.adapterName]).toEqual([driver.provider, driver.adapterName]);
		expect([connection.provider, connection.adapterName]).toEqual([
			driver.provider,
			driver.adapterName
		]);
	});

	it('carries the transaction options Prisma reads to decide how to close it', async () => {
		expect.assertions(1);

		// Prisma sends the COMMIT/ROLLBACK statement itself only when `usePhantomQuery` is false.
		const tx = await connection.startTransaction();
		const options = tx.options;
		await rollBack(tx);

		expect(options).toEqual({ usePhantomQuery: false });
	});

	it('exposes getConnectionInfo exactly when the driver does', async () => {
		expect.assertions(1);

		const raw = await new PrismaBetterSqlite3({ url: ':memory:' }).connect();
		const rawHasIt = 'getConnectionInfo' in raw;
		await raw.dispose();

		expect('getConnectionInfo' in connection).toBe(rawHasIt);
	});

	it('runs savepoints on the transaction, for nested transactions', async () => {
		expect.assertions(1);

		const tx = await connection.startTransaction();
		await tx.executeRaw(statement('UPDATE t SET v = 1 WHERE id = 1'));
		await tx.createSavepoint?.('inner');
		await tx.executeRaw(statement('UPDATE t SET v = 2 WHERE id = 1'));
		await tx.rollbackToSavepoint?.('inner');
		await tx.releaseSavepoint?.('inner');
		const inside = await tx.queryRaw(statement('SELECT v FROM t WHERE id = 1'));
		await commit(tx);

		// 1, not 2 (the savepoint rolled back) and not 0 (the outer write survived it).
		expect(Number(inside.rows[0][0])).toBe(1);
	});
});

// ---------------------------------------------------------------------------------------------
// The failed-commit close, on a file database.
// ---------------------------------------------------------------------------------------------

/**
 * A second handle from the SAME better-sqlite3 the adapter loads, resolved from the adapter's own
 * location. It has to be the same library: SQLite's file locks are POSIX advisory locks, which do
 * not conflict within one process, and SQLite only arbitrates between connections it can see. A
 * reader opened through `node:sqlite`, which embeds its own copy, was measured NOT to block the
 * adapter's COMMIT, so a test using it would read « no BUSY » about the instrument.
 */
interface SqliteHandle {
	exec(sql: string): unknown;
	prepare(sql: string): { all(): unknown[] };
	close(): unknown;
}
type SqliteHandleConstructor = new (
	file: string,
	options?: { readonly?: boolean; timeout?: number }
) => SqliteHandle;
const requireHere = createRequire(import.meta.url);
const SameLibraryDatabase = createRequire(requireHere.resolve('@prisma/adapter-better-sqlite3'))(
	'better-sqlite3'
) as SqliteHandleConstructor;

/** Short, so a BUSY arrives quickly: better-sqlite3's busy wait blocks the event loop meanwhile. */
const BUSY_TIMEOUT_MS = 100;

let directory: string;
let file: string;

function useFreshFile(): void {
	directory = mkdtempSync(join(tmpdir(), 'bp-serialized-sqlite-'));
	file = join(directory, 'busy.db');
}

function removeFile(): void {
	rmSync(directory, { recursive: true, force: true });
}

const CREATE_TABLE = 'CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)';
const SEED_ROWS = 'INSERT INTO t VALUES (1, 0), (2, 0)';

/** A second connection in an open read transaction, holding SHARED, so a COMMIT cannot finish. */
function holdShared(): () => void {
	const reader = new SameLibraryDatabase(file);
	reader.exec('BEGIN');
	reader.prepare('SELECT v FROM t').all();
	return () => {
		reader.exec('COMMIT');
		reader.close();
	};
}

/**
 * What a brand-new connection reads, which is only ever COMMITTED data, or `locked` when it cannot
 * read at all (a writer left holding PENDING after a failed COMMIT refuses new readers).
 */
function readFresh(): Array<[number, number]> | 'locked' {
	const fresh = new SameLibraryDatabase(file, { readonly: true, timeout: BUSY_TIMEOUT_MS });
	try {
		const rows = fresh.prepare('SELECT id, v FROM t ORDER BY id').all() as Array<{
			id: number | bigint;
			v: number | bigint;
		}>;
		return rows.map((row) => [Number(row.id), Number(row.v)]);
	} catch (error) {
		if ((error as { code?: unknown }).code === 'SQLITE_BUSY') return 'locked';
		throw error;
	} finally {
		fresh.close();
	}
}

async function outcomeAfter(
	work: Promise<unknown>,
	ms: number
): Promise<'fulfilled' | 'rejected' | 'pending'> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const pending = new Promise<'pending'>((resolve) => {
		timer = setTimeout(() => resolve('pending'), ms);
	});
	try {
		return await Promise.race([
			work.then(
				() => 'fulfilled' as const,
				() => 'rejected' as const
			),
			pending
		]);
	} finally {
		clearTimeout(timer);
	}
}

describe('when the COMMIT statement itself fails, as SQLITE_BUSY makes it', () => {
	let fileConnection: Connection;

	beforeEach(async () => {
		useFreshFile();
		fileConnection = await new SerializedSqliteAdapterFactory(
			new PrismaBetterSqlite3({ url: `file:${file}`, timeout: BUSY_TIMEOUT_MS })
		).connect();
		await fileConnection.executeScript(`${CREATE_TABLE}; ${SEED_ROWS};`);
	});

	afterEach(async () => {
		await fileConnection.dispose();
		removeFile();
	});

	/**
	 * Prisma's failed-commit close, step for step (client runtime 7.10.0, the `#f` close): the COMMIT
	 * statement rejects, then `rollback()` is called and NO ROLLBACK statement is sent. Returns the
	 * COMMIT's error. The `PrismaClient` block below drives the same sequence through Prisma itself.
	 */
	async function closeWithFailedCommit(): Promise<unknown> {
		const releaseReader = holdShared();
		try {
			const tx = await fileConnection.startTransaction();
			await tx.executeRaw(statement('UPDATE t SET v = 1 WHERE id = 1'));
			const commitError = await tx.executeRaw(statement('COMMIT')).then(
				() => null,
				(error: unknown) => error
			);
			await tx.rollback();
			return commitError;
		} finally {
			releaseReader();
		}
	}

	it('fails the COMMIT with SQLITE_BUSY, so this block measures that path at all', async () => {
		expect.assertions(1);

		expect(await closeWithFailedCommit()).toMatchObject({
			cause: { originalCode: 'SQLITE_BUSY' }
		});
	});

	it('really rolls the transaction back, so a fresh connection reads only committed rows', async () => {
		expect.assertions(1);

		// Separates « rollback() ended the transaction » from « it released the hold and left BEGIN
		// open », where the writer keeps PENDING and a fresh connection cannot read at all.
		await closeWithFailedCommit();

		expect(readFresh()).toEqual([
			[1, 0],
			[2, 0]
		]);
	});

	it('lets the next outside write commit on its own, visible from a fresh connection', async () => {
		expect.assertions(1);

		// The #889 defect on this path: with BEGIN left open, the outside write runs inside the dead
		// transaction and is never committed.
		await closeWithFailedCommit();
		await fileConnection.executeRaw(statement('UPDATE t SET v = 1 WHERE id = 2'));

		expect(readFresh()).toEqual([
			[1, 0],
			[2, 1]
		]);
	});

	it('opens the next transaction', async () => {
		expect.assertions(1);

		// With BEGIN left open, the next BEGIN throws « cannot start a transaction within a
		// transaction » after the adapter has taken its private mutex, which it then never releases.
		await closeWithFailedCommit();
		const next = fileConnection.startTransaction();
		const outcome = await outcomeAfter(next, RELEASED_WITHIN_MS);
		if (outcome === 'fulfilled') await rollBack(await next);

		expect(outcome).toBe('fulfilled');
	});

	it('opens the one after that too, instead of waiting forever on a leaked mutex', async () => {
		expect.assertions(1);

		// The outage: the second attempt leaked the adapter's mutex, so this one takes OUR hold and
		// waits on that mutex for good, and every query on the connection queues behind it.
		await closeWithFailedCommit();
		const second = await fileConnection.startTransaction().catch(() => null);
		if (second) await rollBack(second);
		const third = fileConnection.startTransaction();
		const outcome = await outcomeAfter(third, RELEASED_WITHIN_MS);
		if (outcome === 'fulfilled') await rollBack(await third);

		expect(outcome).toBe('fulfilled');
	});
});

describe('the ROLLBACK the decorator sends itself on rollback()', () => {
	type Factory = ConstructorParameters<typeof SerializedSqliteAdapterFactory>[0];

	/**
	 * The real driver, with ONLY the transaction's ROLLBACK statement routed through `onRollback`.
	 * A test double, and named as one: a ROLLBACK that fails for any reason but « no transaction is
	 * active » is an I/O-level failure that cannot be produced on demand, and a slow one cannot be
	 * produced at all by a driver that runs every statement synchronously.
	 */
	function withRollbackRoutedThrough(
		onRollback: (run: () => Promise<number>) => Promise<number>
	): Factory {
		const driver = new PrismaBetterSqlite3({ url: `file:${file}`, timeout: BUSY_TIMEOUT_MS });
		return {
			provider: driver.provider,
			adapterName: driver.adapterName,
			connectToShadowDb: () => driver.connectToShadowDb(),
			async connect() {
				const adapter = await driver.connect();
				return {
					provider: adapter.provider,
					adapterName: adapter.adapterName,
					queryRaw: (query) => adapter.queryRaw(query),
					executeRaw: (query) => adapter.executeRaw(query),
					executeScript: (script) => adapter.executeScript(script),
					dispose: () => adapter.dispose(),
					async startTransaction(isolationLevel) {
						const tx = await adapter.startTransaction(isolationLevel);
						return {
							provider: tx.provider,
							adapterName: tx.adapterName,
							options: tx.options,
							queryRaw: (query) => tx.queryRaw(query),
							executeRaw: (query) =>
								query.sql === 'ROLLBACK'
									? onRollback(() => tx.executeRaw(query))
									: tx.executeRaw(query),
							commit: () => tx.commit(),
							rollback: () => tx.rollback()
						};
					}
				};
			}
		};
	}

	let routed: Connection | undefined;

	async function connectRouted(
		onRollback: (run: () => Promise<number>) => Promise<number>
	): Promise<Connection> {
		routed = await new SerializedSqliteAdapterFactory(
			withRollbackRoutedThrough(onRollback)
		).connect();
		await routed.executeScript(`${CREATE_TABLE}; ${SEED_ROWS};`);
		return routed;
	}

	beforeEach(() => {
		routed = undefined;
		useFreshFile();
	});

	afterEach(async () => {
		await routed?.dispose();
		removeFile();
	});

	it('is swallowed when it finds no transaction, which is the ordinary rollback', async () => {
		expect.assertions(1);

		// The calibration of the matcher on the REAL error: Prisma has already sent ROLLBACK, so the
		// decorator's own ROLLBACK meets SQLite's « cannot rollback - no transaction is active ». If
		// the matcher missed that error, every ordinary rollback would reject here.
		const db = await connectRouted((run) => run());
		const tx = await db.startTransaction();

		await expect(rollBack(tx)).resolves.toBeUndefined();
	});

	it('is rethrown when it fails for any other reason', async () => {
		expect.assertions(1);

		const planted = new Error('planted: disk I/O error during ROLLBACK');
		const db = await connectRouted(() => Promise.reject(planted));
		const tx = await db.startTransaction();

		await expect(tx.rollback()).rejects.toBe(planted);
	});

	it('still releases the hold when it fails, since a permanent hang is worse', async () => {
		expect.assertions(1);

		const db = await connectRouted(() =>
			Promise.reject(new Error('planted: disk I/O error during ROLLBACK'))
		);
		const tx = await db.startTransaction();
		await tx.rollback().catch(() => undefined);

		expect(
			await outcomeAfter(db.queryRaw(statement('SELECT v FROM t WHERE id = 1')), RELEASED_WITHIN_MS)
		).toBe('fulfilled');
	});

	it('runs under the hold, so a write queued behind it cannot land in the dying transaction', async () => {
		expect.assertions(1);

		// A slow ROLLBACK: if the hold were released before the ROLLBACK finished, the queued outside
		// write would run inside the transaction and be undone with it. Separates « released after
		// the ROLLBACK » from « released before it ».
		const db = await connectRouted(async (run) => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			return run();
		});
		const tx = await db.startTransaction();
		await tx.executeRaw(statement('UPDATE t SET v = 1 WHERE id = 1'));
		const closing = tx.rollback();
		const outside = db.executeRaw(statement('UPDATE t SET v = 1 WHERE id = 2'));
		await closing;
		await outside;

		expect(readFresh()).toEqual([
			[1, 0],
			[2, 1]
		]);
	});
});

describe('a failed COMMIT, through Prisma’s own client', () => {
	/**
	 * The same failure with nothing performed by the test but the reader holding SHARED: the close
	 * sequence after the COMMIT fails is Prisma's own, not `closeWithFailedCommit`'s.
	 */
	let client: PrismaClient;

	beforeEach(async () => {
		useFreshFile();
		client = new PrismaClient({
			adapter: new SerializedSqliteAdapterFactory(
				new PrismaBetterSqlite3({ url: `file:${file}`, timeout: BUSY_TIMEOUT_MS })
			)
		});
		await client.$executeRawUnsafe(CREATE_TABLE);
		await client.$executeRawUnsafe(SEED_ROWS);
	});

	afterEach(async () => {
		await client.$disconnect();
		removeFile();
	});

	async function transactionWithFailedCommit(): Promise<unknown> {
		const releaseReader = holdShared();
		try {
			return await client
				.$transaction(async (tx) => {
					await tx.$executeRawUnsafe('UPDATE t SET v = 1 WHERE id = 1');
				})
				.then(
					() => null,
					(error: unknown) => error
				);
		} finally {
			releaseReader();
		}
	}

	it('rejects the transaction because its COMMIT met SQLITE_BUSY', async () => {
		expect.assertions(1);

		// The precondition: the client really went down the failed-commit path. It passes the
		// driver's error through rather than mapping it to a P-code (measured).
		expect(await transactionWithFailedCommit()).toMatchObject({
			cause: { originalCode: 'SQLITE_BUSY' }
		});
	});

	it('commits the next outside write on its own, visible from a fresh connection', async () => {
		expect.assertions(1);

		await transactionWithFailedCommit();
		await client.$executeRawUnsafe('UPDATE t SET v = 1 WHERE id = 2');

		expect(readFresh()).toEqual([
			[1, 0],
			[2, 1]
		]);
	});

	it('opens the next two transactions, rather than refusing one and hanging the other', async () => {
		expect.assertions(1);

		await transactionWithFailedCommit();
		const outcomes: string[] = [];
		for (let attempt = 0; attempt < 2; attempt += 1) {
			outcomes.push(
				await outcomeAfter(
					client.$transaction(async (tx) => tx.$queryRawUnsafe('SELECT 1')),
					RELEASED_WITHIN_MS
				)
			);
		}

		expect(outcomes).toEqual(['fulfilled', 'fulfilled']);
	});
});
