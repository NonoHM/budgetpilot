import {
	assertDatabaseUrlMatchesProvider,
	resolveDatabaseProvider,
	type DatabaseEnv
} from './provider';

/**
 * One name for the three database checks the boot collector has to run.
 *
 * It DELEGATES rather than restates. `resolveDatabaseProvider` already owns the "not a supported
 * database" message and `assertDatabaseUrlMatchesProvider` already owns the scheme disagreement,
 * and both are good; retyping either here would be a second source that drifts from the one the
 * app actually uses. Only the presence check is written here, and only because db.ts's version
 * throws from a module body, which the collector cannot catch in place.
 *
 * The production condition is deliberately identical to db.ts's: outside production a missing
 * DATABASE_URL falls back to a local dev file, and refusing to start there would break `vite dev`
 * for everyone who has never set one.
 */
export function assertDatabaseConfigured(source: NodeJS.ProcessEnv = process.env): void {
	const databaseUrl = source.DATABASE_URL?.trim();
	if (!databaseUrl && source.NODE_ENV === 'production') {
		throw new Error(
			'DATABASE_URL is required in production: without it the app would silently open a fresh, ' +
				'empty SQLite file instead of your data. In the shipped container it is ' +
				'`file:/data/dev.db`, which is on the mounted volume — a path outside /data is on the ' +
				'read-only layer and will not survive a restart. For PostgreSQL or MySQL/MariaDB, use ' +
				'your server\'s connection URL and set DATABASE_PROVIDER to match it.'
		);
	}
	const provider = resolveDatabaseProvider(source as DatabaseEnv);
	assertDatabaseUrlMatchesProvider(provider, databaseUrl);
}
