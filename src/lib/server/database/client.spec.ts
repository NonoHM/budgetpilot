import { describe, expect, it, vi } from 'vitest';
import { createPrismaClient } from './client';
import { DEFAULT_SQLITE_URL } from './provider';

const createDatabaseAdapter = vi.hoisted(() => vi.fn(() => ({ adapterName: 'fake' })));

vi.mock('./adapter.ts', () => ({ createDatabaseAdapter }));
vi.mock('@prisma/client', () => ({
	default: { PrismaClient: class FakePrismaClient {} }
}));

describe('createPrismaClient', () => {
	it('falls back to the local dev file for sqlite with no DATABASE_URL', () => {
		expect.assertions(1);

		// The zero-config default: no environment at all still starts against dev.db.
		createPrismaClient({});

		expect(createDatabaseAdapter).toHaveBeenCalledWith('sqlite', DEFAULT_SQLITE_URL);
	});

	it.each(['postgresql', 'mysql'])('refuses to guess a URL for %s', (provider) => {
		expect.assertions(1);

		// Unlike SQLite there is no local file to fall back on, and inventing a host would
		// produce a connection error naming the wrong problem.
		expect(() => createPrismaClient({ DATABASE_PROVIDER: provider })).toThrow(
			/DATABASE_URL is required/
		);
	});

	it('passes the configured provider and URL through to the adapter', () => {
		expect.assertions(1);

		createPrismaClient({
			DATABASE_PROVIDER: 'postgres',
			DATABASE_URL: 'postgresql://user:pass@localhost:5432/budgetpilot'
		});

		// "postgres" resolves to Prisma's own provider name on the way through.
		expect(createDatabaseAdapter).toHaveBeenCalledWith(
			'postgresql',
			'postgresql://user:pass@localhost:5432/budgetpilot'
		);
	});

	it('rejects a URL belonging to another engine before connecting to anything', () => {
		expect.assertions(1);

		expect(() =>
			createPrismaClient({ DATABASE_PROVIDER: 'mysql', DATABASE_URL: 'file:./dev.db' })
		).toThrow(/does not match/);
	});

	it('rejects an unrecognised provider instead of falling back to sqlite', () => {
		expect.assertions(1);

		expect(() => createPrismaClient({ DATABASE_PROVIDER: 'postgres_' })).toThrow(
			/not a supported database/
		);
	});
});
