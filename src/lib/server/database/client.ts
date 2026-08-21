// Relative, `.ts`-suffixed imports, like server/naming/backfill.ts: this module is also
// imported by the maintenance scripts under scripts/, which plain Node runs with no Vite
// resolution and no `$lib` alias.
import { createDatabaseAdapter, type DatabaseAdapterOptions } from './adapter.ts';
import { moneyColumnsExtension } from './moneyColumns.ts';
import {
	assertDatabaseUrlMatchesProvider,
	DEFAULT_SQLITE_URL,
	normalizeDatabaseUrl,
	resolveDatabaseProvider,
	type DatabaseEnv
} from './provider.ts';
// One generated client per provider, all three imported statically, for the same reason
// adapter.ts imports all three drivers statically: making this module async would push `await`
// into every one of the fifty-odd modules that import `prisma`.
import { PrismaClient as MysqlPrismaClient } from './generated/mysql/client.ts';
import { PrismaClient as PostgresqlPrismaClient } from './generated/postgresql/client.ts';
import { PrismaClient as SqlitePrismaClient } from './generated/sqlite/client.ts';

// All three clients are derived from one authored schema by schemaGenerator.ts, which varies
// only the datasource block and the native column types, so they are structurally identical and
// any one of them can name the type.
type BasePrismaClient = SqlitePrismaClient;

/**
 * Builds a Prisma client for the configured provider.
 *
 * The single expression of "how this application connects to its database", used by the app's
 * own singleton in `db.ts` and by the maintenance scripts under `scripts/`. Those scripts each
 * used to construct a SQLite adapter directly, which was correct while SQLite was the only
 * option and quietly wrong the moment it was not: handed a `postgresql://` URL, a SQLite
 * adapter opens a local file named after the connection string rather than saying it cannot.
 *
 * `db.ts` keeps what is specific to the running server (the production DATABASE_URL
 * requirement, the hot-reload singleton); everything about which engine and which URL lives
 * here.
 *
 * The return type is INFERRED rather than written out, and that is deliberate: naming Prisma's
 * extended-client type means naming a generated type that changes shape with the extension, and
 * every consumer already derives from this one (`db.ts` uses `ReturnType<typeof
 * createPrismaClient>`, and `database/types.ts` re-exports it), so the inference reaches all of
 * them with no signature to keep in step.
 */
export function createPrismaClient(
	env: DatabaseEnv = process.env,
	options: DatabaseAdapterOptions = {}
) {
	const provider = resolveDatabaseProvider(env);
	// Normalised once, here, and everything downstream uses the result. Validating one string
	// and connecting with another is how a stray leading space used to reach the driver's
	// parse error, which quotes the whole connection string.
	const databaseUrl = normalizeDatabaseUrl(env.DATABASE_URL);
	assertDatabaseUrlMatchesProvider(provider, databaseUrl);

	// Only SQLite has somewhere sensible to default to. PostgreSQL and MySQL have no local file
	// to fall back on, and inventing a host would produce a connection error naming the wrong
	// problem.
	if (!databaseUrl && provider !== 'sqlite') {
		throw new Error(`DATABASE_URL is required when DATABASE_PROVIDER is "${provider}"`);
	}

	const adapter = createDatabaseAdapter(provider, databaseUrl ?? DEFAULT_SQLITE_URL, options);

	// A generated client embeds the schema it came from and refuses an adapter that does not
	// match it, so the client and the adapter have to be chosen from the same provider.
	//
	// Every branch goes through the same `$extends`, and that is the point rather than a tidiness:
	// this function is the ONLY place a client is built (verified: no `new *PrismaClient(` and no
	// import of a generated client exists anywhere else in the tree), so a caller cannot obtain one
	// whose money columns are still `bigint`. See moneyColumns.ts for what the extension does not
	// reach.
	return selectClient(provider, adapter).$extends(moneyColumnsExtension);
}

function selectClient(
	provider: ReturnType<typeof resolveDatabaseProvider>,
	adapter: ReturnType<typeof createDatabaseAdapter>
): BasePrismaClient {
	switch (provider) {
		case 'sqlite':
			return new SqlitePrismaClient({ adapter });
		case 'postgresql':
			return new PostgresqlPrismaClient({ adapter }) as BasePrismaClient;
		case 'mysql':
			return new MysqlPrismaClient({ adapter }) as BasePrismaClient;
	}
}
