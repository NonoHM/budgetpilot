import prismaClientPkg from '@prisma/client';
// Relative, `.ts`-suffixed imports, like server/naming/backfill.ts: this module is also
// imported by the maintenance scripts under scripts/, which plain Node runs with no Vite
// resolution and no `$lib` alias.
import { createDatabaseAdapter } from './adapter.ts';
import {
	assertDatabaseUrlMatchesProvider,
	DEFAULT_SQLITE_URL,
	resolveDatabaseProvider,
	type DatabaseEnv
} from './provider.ts';

type PrismaClientType = import('@prisma/client').PrismaClient;

const { PrismaClient } = prismaClientPkg;

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
 */
export function createPrismaClient(env: DatabaseEnv = process.env): PrismaClientType {
	const provider = resolveDatabaseProvider(env);
	assertDatabaseUrlMatchesProvider(provider, env.DATABASE_URL);

	// Only SQLite has somewhere sensible to default to. PostgreSQL and MySQL have no local file
	// to fall back on, and inventing a host would produce a connection error naming the wrong
	// problem.
	if (!env.DATABASE_URL && provider !== 'sqlite') {
		throw new Error(`DATABASE_URL is required when DATABASE_PROVIDER is "${provider}"`);
	}

	const adapter = createDatabaseAdapter(provider, env.DATABASE_URL ?? DEFAULT_SQLITE_URL);
	return new PrismaClient({ adapter });
}
