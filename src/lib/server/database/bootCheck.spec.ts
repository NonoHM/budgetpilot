import { describe, expect, it } from 'vitest';
import { assertDatabaseConfigured } from './bootCheck';

describe('assertDatabaseConfigured', () => {
	it('refuses a missing DATABASE_URL in production and names the value to set', () => {
		expect(() => assertDatabaseConfigured({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
		expect(() => assertDatabaseConfigured({ NODE_ENV: 'production' })).toThrow(
			/file:\/data\/budgetpilot\.db/
		);
	});

	// Outside production a missing URL is legal: db.ts falls back to a local dev file, and
	// refusing here would break `vite dev` for anyone who never set one.
	it('accepts a missing DATABASE_URL outside production', () => {
		expect(() => assertDatabaseConfigured({ NODE_ENV: 'development' })).not.toThrow();
	});

	// Delegated, not retyped: the scheme/provider disagreement message belongs to provider.ts.
	// This asserts that it SURFACES through the collector's entry point, never restates its wording.
	it('surfaces a provider that does not match the URL scheme', () => {
		expect(() =>
			assertDatabaseConfigured({
				NODE_ENV: 'production',
				DATABASE_URL: 'postgresql://user:pass@host:5432/db',
				DATABASE_PROVIDER: 'sqlite'
			})
		).toThrow(/does not match DATABASE_PROVIDER/);
	});

	it('surfaces an unsupported provider', () => {
		expect(() =>
			assertDatabaseConfigured({
				NODE_ENV: 'production',
				DATABASE_URL: 'file:/data/budgetpilot.db',
				DATABASE_PROVIDER: 'oracle'
			})
		).toThrow(/not a supported database/);
	});

	it('accepts a consistent pair', () => {
		expect(() =>
			assertDatabaseConfigured({
				NODE_ENV: 'production',
				DATABASE_URL: 'file:/data/budgetpilot.db'
			})
		).not.toThrow();
	});
});
