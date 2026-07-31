import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaPg } from '@prisma/adapter-pg';
import { toDriverConnectionUrl, type DatabaseProvider } from './provider.ts';

/**
 * Builds the Prisma driver adapter for the configured provider.
 *
 * Separate from `db.ts` so the singleton and the engine choice stay one concern each: `db.ts`
 * decides when a client exists, this decides what it talks to.
 *
 * All three adapters are imported statically even though exactly one is ever constructed. The
 * unused two cost an import of two pure-JS drivers, which is cheaper than the alternative:
 * making the module async would push `await` into every one of the fifty-odd modules that
 * import `prisma`.
 */
export interface DatabaseAdapterOptions {
	/**
	 * Keep the pool at exactly one connection, and never reap it while it sits idle.
	 *
	 * For code that holds a session-scoped lock. `pg`'s pool defaults are `min: 0` and
	 * `idleTimeoutMillis: 10000`, so a connection that takes a `pg_advisory_lock` and then goes
	 * quiet is closed after ten seconds, and PostgreSQL releases every advisory lock the session
	 * held. Observed, not deduced: a lock taken by server/database/advisoryLock.ts disappeared
	 * from `pg_locks` between the eighth and thirteenth second of the work it was protecting.
	 *
	 * `max: 1` makes "the connection" a single thing that the keep-alive query can reach, and
	 * `idleTimeoutMillis: 0` disables the reaper outright.
	 *
	 * Nothing to set for MariaDB: its pool keeps `minimumIdle` at `connectionLimit`, idles for
	 * half an hour, and does not reset a connection when it returns to the pool, so a `GET_LOCK`
	 * survives on its own.
	 */
	singleConnection?: boolean;
}

export function createDatabaseAdapter(
	provider: DatabaseProvider,
	url: string,
	options: DatabaseAdapterOptions = {}
) {
	switch (provider) {
		case 'sqlite':
			return new PrismaBetterSqlite3({ url });
		case 'postgresql':
			return options.singleConnection
				? new PrismaPg({ connectionString: url, max: 1, idleTimeoutMillis: 0 })
				: new PrismaPg(url);
		case 'mysql':
			// See toDriverConnectionUrl: the MariaDB driver only parses `mariadb://`, and it
			// quotes the whole connection string when it refuses one.
			return new PrismaMariaDb(toDriverConnectionUrl(provider, url));
	}
}
