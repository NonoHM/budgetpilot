import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaPg } from '@prisma/adapter-pg';
import { describe, expect, it, vi } from 'vitest';
import { createDatabaseAdapter } from './adapter';

vi.mock('@prisma/adapter-pg', async (importOriginal) => {
	const original = await importOriginal<typeof import('@prisma/adapter-pg')>();
	return { ...original, PrismaPg: vi.fn(original.PrismaPg) };
});

vi.mock('@prisma/adapter-mariadb', async (importOriginal) => {
	const original = await importOriginal<typeof import('@prisma/adapter-mariadb')>();
	// Spied rather than stubbed: the real constructor still runs (it does not connect), and the
	// spy records the URL it was handed, which is the thing worth asserting.
	return { ...original, PrismaMariaDb: vi.fn(original.PrismaMariaDb) };
});

describe('createDatabaseAdapter', () => {
	it('builds a better-sqlite3 adapter for sqlite', () => {
		expect.assertions(1);

		expect(createDatabaseAdapter('sqlite', 'file:./dev.db')).toBeInstanceOf(PrismaBetterSqlite3);
	});

	it('builds a pg adapter for postgresql', () => {
		expect.assertions(1);

		expect(
			createDatabaseAdapter('postgresql', 'postgresql://user:pass@localhost:5432/budgetpilot')
		).toBeInstanceOf(PrismaPg);
	});

	it('builds a mariadb adapter for mysql', () => {
		expect.assertions(1);

		expect(
			createDatabaseAdapter('mysql', 'mysql://user:pass@localhost:3306/budgetpilot')
		).toBeInstanceOf(PrismaMariaDb);
	});

	it('hands the MariaDB driver a rewritten mariadb:// URL, never the raw mysql:// one', () => {
		expect.assertions(1);

		// The driver parses connection strings against a regex anchored on `mariadb://`, and
		// quotes the whole string (password included) when it refuses one. The rewrite has to
		// happen before the URL reaches it, not merely exist as a helper.
		vi.mocked(PrismaMariaDb).mockClear();
		createDatabaseAdapter('mysql', 'mysql://user:pass@localhost:3306/budgetpilot');

		expect(vi.mocked(PrismaMariaDb)).toHaveBeenCalledWith(
			'mariadb://user:pass@localhost:3306/budgetpilot'
		);
	});

	it('pins the pg pool to one never-reaped connection when asked for a single connection', () => {
		expect.assertions(1);

		// pg's pool defaults are `min: 0` and `idleTimeoutMillis: 10000`, so a connection holding
		// a session-scoped advisory lock is closed ten seconds after it goes quiet, and
		// PostgreSQL releases the lock with the session. Reproduced against a real server before
		// this existed: the lock vanished from pg_locks partway through the backfill.
		vi.mocked(PrismaPg).mockClear();
		createDatabaseAdapter('postgresql', 'postgresql://user:pass@localhost:5432/budgetpilot', {
			singleConnection: true
		});

		expect(vi.mocked(PrismaPg)).toHaveBeenCalledWith({
			connectionString: 'postgresql://user:pass@localhost:5432/budgetpilot',
			max: 1,
			idleTimeoutMillis: 0
		});
	});
});
