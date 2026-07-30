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
export function createDatabaseAdapter(provider: DatabaseProvider, url: string) {
	switch (provider) {
		case 'sqlite':
			return new PrismaBetterSqlite3({ url });
		case 'postgresql':
			return new PrismaPg(url);
		case 'mysql':
			// See toDriverConnectionUrl: the MariaDB driver only parses `mariadb://`, and it
			// quotes the whole connection string when it refuses one.
			return new PrismaMariaDb(toDriverConnectionUrl(provider, url));
	}
}
