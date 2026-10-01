import { describe, expect, it, vi } from 'vitest';
import { assertDatabaseConfigured } from './bootCheck';

// The collector imports every check's module, and several reach the Prisma client. Nothing here
// queries, so the client is replaced, as in assertConfigured.spec.ts: constructing it made the
// import slow enough to time out under the full suite.
vi.mock('$lib/server/db', () => ({ prisma: {} }));
const { collectEnvironmentProblems } = await import('$lib/server/env/assertConfigured');

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

// #816's second contradiction pass: the two refusals provider.ts owns were thrown as a plain Error,
// so the collector, which keeps a message only from an OperatorFacingError, reduced them to
// « DATABASE_URL / DATABASE_PROVIDER: Error » and the operator lost the instructions. Read through
// the collector, as the report receives it, because calling the check directly stays green.
describe('assertDatabaseConfigured, as the boot report receives it', () => {
	it.each([
		[
			'an unsupported provider',
			{ DATABASE_PROVIDER: 'oracle', DATABASE_URL: 'file:x' },
			/^DATABASE_PROVIDER="oracle" is not a supported database/
		],
		[
			'a scheme the provider does not take',
			{ DATABASE_PROVIDER: 'postgresql', DATABASE_URL: 'file:x' },
			/^DATABASE_URL uses the "file" scheme, which does not match/
		]
	])('keeps the refusal for %s', async (_, source, expected) => {
		const [problem] = await collectEnvironmentProblems([
			['DATABASE_URL / DATABASE_PROVIDER', () => assertDatabaseConfigured(source)]
		]);
		expect(problem).toMatch(expected);
	});
});
