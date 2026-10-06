import type { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

/**
 * Keeps a query issued outside an open transaction OUT of it, on SQLite (#889).
 *
 * ## Why this exists
 *
 * `@prisma/adapter-better-sqlite3` (7.10.0, and 8.1.0-dev.7 is byte-identical) runs every query
 * on ONE better-sqlite3 connection. Its `startTransaction` takes a private mutex and runs `BEGIN`
 * on that connection; its `queryRaw`, `executeRaw` and `executeScript` take no lock at all. So a
 * plain query issued by one request while another request's interactive transaction is open runs
 * INSIDE that transaction, and its rollback undoes a write its caller was told had succeeded.
 * Measured by `transactionIsolation.db-smoke.ts`: on SQLite the outside write was undone, and an
 * outside read saw the uncommitted value; on PostgreSQL and MariaDB neither happened.
 *
 * WHEN another request can get in: only while the transaction awaits something that is NOT the
 * database (a timer, a network call, an async hash). better-sqlite3 is synchronous, so a callback
 * that awaits only database calls never yields to the event loop, and a request arriving meanwhile
 * runs after it. Measured through `createPrismaClient` on 2026-10-06: work scheduled with
 * `setImmediate` or `setTimeout(0)` interleaved 0 times in 4 trials of 1 and 2000 database-only
 * awaits, and 2 times in 2 trials with one 20 ms timer added, its write then undone. No production
 * callback awaits anything else today (the sweep below), so this closes a trap rather than a live
 * loss: the first transaction that awaits a fetch or a hash would otherwise lose other requests'
 * writes silently, with every test written against database-only callbacks still green.
 *
 * The precedent is the sibling adapter: `@prisma/adapter-libsql` 7.10.0 takes ONE mutex in every
 * base query and in `startTransaction`, and releases it on commit or rollback. This decorator gives
 * the better-sqlite3 adapter the same shape from outside, through Prisma's public driver-adapter
 * interfaces, without reaching into the adapter's private fields.
 *
 * ## The close the hold depends on
 *
 * Releasing on `rollback()` is only safe if the transaction is really over, and Prisma does not
 * always make it so: when the COMMIT statement itself fails (SQLITE_BUSY because another
 * connection holds a read, such as the documented `normalize-names --dry-run` against the live
 * volume or a SQLite browser, or an I/O error), Prisma 7.10.0 calls `rollback()` with no ROLLBACK
 * statement, and SQLite leaves the transaction open. So `rollback()` sends ROLLBACK itself, under
 * the hold, and treats « no transaction is active » as the ordinary case. Without that, measured
 * through Prisma's own client, the next outside write ran inside the dead transaction, the next
 * transaction was refused, and the one after waited forever on the adapter's leaked mutex.
 *
 * ## What it changes, honestly
 *
 * On SQLite a request now WAITS while another request's transaction is open and awaiting something
 * else, where before it silently joined it. A database-only transaction already held the one
 * thread to its end, so for those nothing changes. PostgreSQL and MariaDB are untouched; they
 * never had the defect.
 *
 * A query on the GLOBAL client made inside a transaction callback now waits for the transaction
 * that is waiting for it. Prisma's own interactive-transaction timeout then rolls that transaction
 * back, which releases the hold, and the caller gets Prisma's « A commit cannot be executed on an
 * expired transaction » error. Measured on SQLite with this decorator: 1001 to 1003 ms for a
 * 1000 ms timeout over three runs, 3002 ms for a 3000 ms one, so the wait is the timeout itself
 * (Prisma's default is 5000 ms). `transactionIsolation.db-smoke.ts`, « the global client used INSIDE
 * a transaction callback », asserts the bound. It fails loudly; it does not hang. A sweep
 * of every `$transaction(` site when this was written (22 interactive, 2 batch; re-derive with
 * `git grep -n '\$transaction(' -- src ':!*.spec.ts' ':!*.db-smoke.ts'`) found no production
 * callback that uses the global client or awaits anything but the database, and the batch form
 * runs its elements on the transaction it opens, so nothing that ships waits on itself.
 *
 * ## When to delete it
 *
 * When the upstream adapter serialises base queries behind its transaction mutex. To check:
 * construct the bare `PrismaBetterSqlite3` in `adapter.ts` instead of wrapping it, and run
 * `transactionIsolation.db-smoke.ts` on SQLite. If « keeps an outside update after the rollback »
 * and « keeps an outside updateMany after the rollback » are green WITHOUT this decorator,
 * upstream has fixed it and this file can go.
 *
 * ## Why explicit members rather than a Proxy
 *
 * A Proxy would forward every member, including a query method a future adapter version adds,
 * and that one would run without the lock: the defect would come back with every test green. Here
 * each member is written against the public interface, so a new required member fails `check`, and
 * a new optional one is simply absent, which Prisma already handles for adapters that lack it.
 */

// The public driver-adapter interfaces, reached through the adapter's own declaration rather than
// by importing `@prisma/driver-adapter-utils`, which is not a direct dependency of this app. This
// also pins them to the exact version the adapter was built against.
type SqliteFactory = Pick<
	PrismaBetterSqlite3,
	'provider' | 'adapterName' | 'connect' | 'connectToShadowDb'
>;
type SqlDriverAdapter = Awaited<ReturnType<PrismaBetterSqlite3['connect']>>;
type Transaction = Awaited<ReturnType<SqlDriverAdapter['startTransaction']>>;

/**
 * A mutual-exclusion lock as a promise chain: each holder waits for the previous one to release.
 *
 * Release is per hold and IDEMPOTENT by construction: it settles this hold's own promise, and
 * settling a settled promise does nothing. So a release that runs twice cannot unlock somebody
 * else's hold, which a single shared "release the current holder" function would.
 */
function createLock(): { acquire(): Promise<() => void> } {
	let tail: Promise<void> = Promise.resolve();
	return {
		acquire() {
			let release!: () => void;
			const held = new Promise<void>((resolve) => {
				release = () => resolve();
			});
			const previous = tail;
			tail = previous.then(() => held);
			return previous.then(() => release);
		}
	};
}

const ROLLBACK: Parameters<Transaction['executeRaw']>[0] = {
	sql: 'ROLLBACK',
	args: [],
	argTypes: []
};

/**
 * SQLite's answer to a ROLLBACK when no transaction is open. Matched on the driver's original code
 * AND its exact message, because the code alone is SQLITE_ERROR, SQLite's generic one, shared by
 * every other failure a ROLLBACK could meet; the adapter maps it to `kind: 'sqlite'`,
 * `extendedCode: 1`, which says no more. The spec calibrates this against the real error: every
 * ordinary rollback reaches it, and would reject if it stopped matching.
 */
function isNoActiveTransaction(error: unknown): boolean {
	if (!(error instanceof Error) || typeof error.cause !== 'object' || error.cause === null) {
		return false;
	}
	const cause = error.cause as { originalCode?: unknown; originalMessage?: unknown };
	return (
		cause.originalCode === 'SQLITE_ERROR' &&
		cause.originalMessage === 'cannot rollback - no transaction is active'
	);
}

/**
 * The transaction, unchanged, except that closing it releases the hold it was opened under, and
 * that rolling it back makes sure it is really rolled back first.
 */
function releasingOnClose(inner: Transaction, release: () => void): Transaction {
	// Only the FIRST close may touch the connection. The ROLLBACK `rollback()` sends goes to the ONE
	// connection, so sent again by a late second close it would end whichever transaction holds the
	// connection by then. The release is already idempotent (see `createLock`); this is the same
	// guarantee one level down, in SQL.
	let closed = false;
	return {
		provider: inner.provider,
		adapterName: inner.adapterName,
		options: inner.options,
		// Queries ON the transaction take no lock: it is already held, by this transaction.
		queryRaw: (query) => inner.queryRaw(query),
		executeRaw: (query) => inner.executeRaw(query),
		// Prisma usually sends the COMMIT or ROLLBACK statement through `executeRaw` above, then
		// calls one of these. Every close path reaches one of them, including a failed COMMIT,
		// which Prisma follows with `rollback()` and NO ROLLBACK statement; see `rollback()`.
		async commit() {
			closed = true;
			try {
				await inner.commit();
			} finally {
				release();
			}
		},
		async rollback() {
			// Sent HERE, unconditionally, because Prisma does not always send it. When the COMMIT
			// statement itself fails (SQLITE_BUSY while another connection holds a read, or an I/O
			// error), Prisma 7.10.0 calls `rollback()` without a ROLLBACK statement, and on SQLite a
			// failed COMMIT leaves the transaction OPEN. Releasing then would hand the next caller a
			// connection still inside BEGIN: its write would join the dead transaction (#889 again),
			// and the next BEGIN would fail after the adapter took its private mutex, which it never
			// releases, so every transaction after that would wait forever.
			//
			// Under our hold, so nobody else can have begun anything on the connection meanwhile.
			const firstClose = !closed;
			closed = true;
			let failure: { error: unknown } | undefined;
			try {
				if (firstClose) await inner.executeRaw(ROLLBACK);
			} catch (error) {
				// The ordinary case: Prisma's own ROLLBACK, or a successful close, already ended it.
				// SQLite's ROLLBACK either ends the transaction or answers exactly that, so what is
				// left here is a JavaScript-level failure, such as a handle already disposed, on a
				// connection that is dead anyway. It is rethrown below AFTER releasing, so it is seen
				// rather than turned into every later query waiting on a hold nobody will release.
				if (!isNoActiveTransaction(error)) failure = { error };
			}
			try {
				await inner.rollback();
			} finally {
				release();
			}
			if (failure) throw failure.error;
		},
		...(inner.createSavepoint && { createSavepoint: inner.createSavepoint.bind(inner) }),
		...(inner.rollbackToSavepoint && {
			rollbackToSavepoint: inner.rollbackToSavepoint.bind(inner)
		}),
		...(inner.releaseSavepoint && { releaseSavepoint: inner.releaseSavepoint.bind(inner) })
	};
}

/** One lock per connected adapter, taken by every base query and held by an open transaction. */
function serializeConnection(inner: SqlDriverAdapter): SqlDriverAdapter {
	const lock = createLock();

	async function exclusive<T>(work: () => Promise<T>): Promise<T> {
		const release = await lock.acquire();
		try {
			return await work();
		} finally {
			release();
		}
	}

	return {
		provider: inner.provider,
		adapterName: inner.adapterName,
		queryRaw: (query) => exclusive(() => inner.queryRaw(query)),
		executeRaw: (query) => exclusive(() => inner.executeRaw(query)),
		executeScript: (script) => exclusive(() => inner.executeScript(script)),
		async startTransaction(isolationLevel) {
			const release = await lock.acquire();
			try {
				return releasingOnClose(await inner.startTransaction(isolationLevel), release);
			} catch (error) {
				// No transaction was opened, so nothing will ever close it and release the hold.
				release();
				throw error;
			}
		},
		...(inner.getConnectionInfo && { getConnectionInfo: inner.getConnectionInfo.bind(inner) }),
		dispose: () => inner.dispose()
	};
}

/** The SQLite driver adapter factory, with every connection it opens serialised. */
export class SerializedSqliteAdapterFactory {
	readonly #inner: SqliteFactory;

	constructor(inner: SqliteFactory) {
		this.#inner = inner;
	}

	get provider(): SqliteFactory['provider'] {
		return this.#inner.provider;
	}

	get adapterName(): string {
		return this.#inner.adapterName;
	}

	async connect(): Promise<SqlDriverAdapter> {
		return serializeConnection(await this.#inner.connect());
	}

	async connectToShadowDb(): Promise<SqlDriverAdapter> {
		return serializeConnection(await this.#inner.connectToShadowDb());
	}
}
