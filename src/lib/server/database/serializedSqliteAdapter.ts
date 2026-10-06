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
 * The precedent is the sibling adapter: `@prisma/adapter-libsql` 7.10.0 takes ONE mutex in every
 * base query and in `startTransaction`, and releases it on commit or rollback. This decorator gives
 * the better-sqlite3 adapter the same shape from outside, through Prisma's public driver-adapter
 * interfaces, without reaching into the adapter's private fields.
 *
 * ## What it changes, honestly
 *
 * On SQLite a request now WAITS while another request's transaction is open, where before it
 * silently joined it. The longest holder is a backup restore, up to its `LONG_TRANSACTION_OPTIONS`
 * timeout. PostgreSQL and MariaDB are untouched; they never had the defect.
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

/** The transaction, unchanged, except that closing it releases the hold it was opened under. */
function releasingOnClose(inner: Transaction, release: () => void): Transaction {
	return {
		provider: inner.provider,
		adapterName: inner.adapterName,
		options: inner.options,
		// Queries ON the transaction take no lock: it is already held, by this transaction.
		queryRaw: (query) => inner.queryRaw(query),
		executeRaw: (query) => inner.executeRaw(query),
		// Prisma sends the COMMIT or ROLLBACK statement through `executeRaw` above, then calls one
		// of these. Every close path reaches one of them, including a failed COMMIT, which Prisma
		// follows with `rollback()`.
		async commit() {
			try {
				await inner.commit();
			} finally {
				release();
			}
		},
		async rollback() {
			try {
				await inner.rollback();
			} finally {
				release();
			}
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
