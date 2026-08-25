import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Opt-in cross-provider database suite — runs against a REAL database server.
 *
 * Every other test in this repository mocks Prisma, which is the right default: it keeps the
 * suite fast and offline. It also means the whole multi-database story was, until this config
 * existed, a claim rather than a feature. The invariants this suite covers are precisely the
 * ones a mock cannot answer, because the database decides them:
 *
 * - whether the unique constraints on the app-computed key columns actually reject a folded
 *   duplicate, on an engine whose own collation would have accepted it;
 * - whether two concurrent writers both land on one row, under an isolation level that does
 *   not serialize them the way SQLite does;
 * - whether a caught unique violation lets the import carry on, on an engine that aborts the
 *   enclosing transaction when a constraint fires.
 *
 * Deliberately a separate config with its own `*.db-smoke.ts` glob: the normal suite
 * (`npm run test:unit`) matches `*.{test,spec}.{js,ts}` and never sees these files, so a
 * developer with no database server keeps a green suite.
 *
 * Run with: DATABASE_PROVIDER=... DATABASE_URL=... npm run test:db
 */
export default defineConfig({
	resolve: {
		alias: {
			$lib: resolve(import.meta.dirname, 'src/lib'),
			// See vitest.db.env-stub.ts. This suite runs without the SvelteKit plugin, so `$env` is
			// unresolvable, and a server module that transitively imports it fails at import time
			// rather than at use. The stub is empty by design.
			'$env/dynamic/private': resolve(import.meta.dirname, 'vitest.db.env-stub.ts')
		}
	},
	test: {
		environment: 'node',
		include: ['src/**/*.db-smoke.ts'],
		// One file, one database. Parallel workers would share the schema and the tests would
		// race each other rather than the concurrency they are meant to exercise.
		fileParallelism: false,
		// Real connections, real round trips, and a container that may still be warming up.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		expect: { requireAssertions: true }
	}
});
