import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SerializedSqliteAdapterFactory } from './serializedSqliteAdapter';

/**
 * The decorator against the REAL better-sqlite3 driver, on an in-memory database, driven the way
 * Prisma's client drives an adapter: `startTransaction`, statements on the transaction, then the
 * COMMIT or ROLLBACK statement through `executeRaw` followed by `commit()` or `rollback()`.
 *
 * In the unit suite on purpose. `transactionIsolation.db-smoke.ts` proves the same property through
 * the full client, but CI's db-matrix runs db-smoke on PostgreSQL and MariaDB only, and SQLite is
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

	it('when startTransaction itself fails, since nothing will ever close it', async () => {
		expect.assertions(1);

		// The adapter refuses any isolation level but SERIALIZABLE, after the decorator has taken
		// its hold: a real failure path through `startTransaction`, not a mock.
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
		await rollBack(second);
		await outside;
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
