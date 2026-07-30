/**
 * Which database the app runs against, resolved from the environment.
 *
 * The operator contract is exactly two variables and nothing more: `DATABASE_PROVIDER` picks
 * the engine, `DATABASE_URL` says where it lives. SQLite stays the zero-config default, so an
 * install that sets neither keeps behaving exactly as it did before multi-database support
 * existed.
 *
 * This module is deliberately dependency-free. It is imported by the app through `$lib`, by
 * `prisma.config.ts` and the schema generator through a relative path in plain Node, so it
 * cannot reach for anything Vite resolves or Prisma provides.
 *
 * Never log or interpolate `DATABASE_URL` itself: it carries the database password. Only its
 * scheme is ever quoted back, which is the one part that helps diagnose a mismatch.
 */

export const DATABASE_PROVIDERS = ['sqlite', 'postgresql', 'mysql'] as const;

export type DatabaseProvider = (typeof DATABASE_PROVIDERS)[number];

export const DEFAULT_DATABASE_PROVIDER: DatabaseProvider = 'sqlite';

/** The dev/default SQLite file, used when no DATABASE_URL is set outside production. */
export const DEFAULT_SQLITE_URL = 'file:./dev.db';

/**
 * Spellings an operator may reasonably type, mapped to Prisma's own provider names.
 *
 * MariaDB is not a separate Prisma provider: it speaks the MySQL protocol and shares the
 * `mysql` datasource. Accepting the name anyway costs nothing and spares an operator running
 * MariaDB from having to know that.
 */
const PROVIDER_ALIASES: Record<string, DatabaseProvider> = {
	sqlite: 'sqlite',
	postgres: 'postgresql',
	postgresql: 'postgresql',
	mysql: 'mysql',
	mariadb: 'mysql'
};

/** URL schemes each provider accepts, used to catch a provider/URL mismatch at startup. */
const PROVIDER_URL_SCHEMES: Record<DatabaseProvider, readonly string[]> = {
	sqlite: ['file'],
	postgresql: ['postgres', 'postgresql'],
	mysql: ['mysql', 'mariadb']
};

export interface DatabaseEnv {
	DATABASE_PROVIDER?: string;
	DATABASE_URL?: string;
}

/**
 * Resolves the configured provider, or throws.
 *
 * An unrecognised value is a hard error rather than a fall back to the default, unlike
 * `REGISTRATION_MODE` where falling back lands on the safe side. Here the safe side does not
 * exist: silently treating `DATABASE_PROVIDER=postgres_` as SQLite would start the app against
 * an empty local file while the operator's real database sat untouched, and every screen would
 * report no data at all. Refusing to start says what is wrong instead.
 */
export function resolveDatabaseProvider(env: DatabaseEnv): DatabaseProvider {
	const raw = env.DATABASE_PROVIDER?.trim().toLowerCase();
	if (!raw) return DEFAULT_DATABASE_PROVIDER;

	const provider = PROVIDER_ALIASES[raw];
	if (!provider) {
		throw new Error(
			`DATABASE_PROVIDER="${raw}" is not a supported database. ` +
				`Use one of: ${DATABASE_PROVIDERS.join(', ')} (or "mariadb" for MariaDB).`
		);
	}
	return provider;
}

/**
 * Rejects a `DATABASE_URL` whose scheme belongs to a different engine.
 *
 * The failure this prevents is quiet and expensive: pointing a PostgreSQL install at
 * `file:./dev.db` connects to nothing an operator expects, and the app then looks empty rather
 * than misconfigured. A missing URL is not this function's business (SQLite has a default, and
 * `db.ts` decides what production requires), so it passes.
 */
export function assertDatabaseUrlMatchesProvider(
	provider: DatabaseProvider,
	databaseUrl: string | undefined
): void {
	if (!databaseUrl) return;

	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(databaseUrl.trim())?.[1]?.toLowerCase();
	const accepted = PROVIDER_URL_SCHEMES[provider];
	if (scheme && accepted.includes(scheme)) return;

	// Quote the scheme only. The rest of the URL is a credential.
	throw new Error(
		`DATABASE_URL uses the "${scheme ?? '(none)'}" scheme, which does not match ` +
			`DATABASE_PROVIDER="${provider}". Expected one of: ${accepted.map((value) => `${value}:`).join(', ')}.`
	);
}

/**
 * Adapts a `DATABASE_URL` to what the provider's driver actually parses.
 *
 * Only MySQL needs it, and the reason is worth stating. MySQL and MariaDB share one Prisma
 * provider and one driver, and that driver parses connection strings against a regex anchored
 * on `mariadb://` alone. Prisma's own convention for the `mysql` provider is `mysql://`, so the
 * URL an operator copies from any Prisma documentation would be rejected.
 *
 * Rejected in the worst possible way, too: the driver's parse error interpolates the whole
 * connection string, so the database password would land in the logs. Rewriting the scheme
 * means that error is never reached. Nothing else about the URL is touched.
 */
export function toDriverConnectionUrl(provider: DatabaseProvider, url: string): string {
	return provider === 'mysql' ? url.replace(/^mysql:\/\//i, 'mariadb://') : url;
}

/**
 * Path to the Prisma schema for a provider.
 *
 * SQLite reads `prisma/schema.prisma` directly: it is the hand-authored source every other
 * schema is generated from, and keeping the default provider on the default filename means
 * `npx prisma migrate dev` and every editor extension keep working with no arguments.
 */
export function schemaPathFor(provider: DatabaseProvider): string {
	return provider === DEFAULT_DATABASE_PROVIDER
		? 'prisma/schema.prisma'
		: `prisma/schema.${provider}.prisma`;
}

/**
 * Where a provider's generated Prisma client is written, as the schema's `output` sees it.
 *
 * Relative to the schema file, because that is what Prisma resolves it against. All three land
 * in the source tree rather than in `node_modules`: generating into `node_modules` is Prisma's
 * legacy pattern, and it makes the client something the Dockerfile has to remember to COPY, so
 * a future refactor that drops a COPY step produces an image whose client is missing at
 * runtime. In the source tree they ride along with `src/` and no COPY can forget them.
 *
 * The directory is build output, never committed. See its README.
 */
export function clientOutputPathFor(provider: DatabaseProvider): string {
	return `../src/lib/server/database/generated/${provider}`;
}

/**
 * Path to a provider's migration history.
 *
 * One history per provider, never shared. The same logical change is different SQL on each
 * engine, and Prisma records only a migration's name as applied, so a shared directory would
 * hand SQLite's `PRAGMA`-flavoured SQL to PostgreSQL.
 */
export function migrationsPathFor(provider: DatabaseProvider): string {
	return `prisma/migrations/${provider}`;
}
