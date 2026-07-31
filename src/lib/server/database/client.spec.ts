import { describe, expect, it, vi } from 'vitest';
import { createPrismaClient } from './client';
import { DEFAULT_SQLITE_URL } from './provider';

const createDatabaseAdapter = vi.hoisted(() => vi.fn(() => ({ adapterName: 'fake' })));

vi.mock('./adapter.ts', () => ({ createDatabaseAdapter }));

// One stand-in per generated client, each distinguishable, so the dispatch test below can prove
// which one was constructed. Mocking them also keeps this suite from loading three real clients.
// Hoisted with the adapter mock above: `vi.mock` factories run before the module body, so a
// plain `class` declaration here would not exist yet when the factory reads it.
const { FakeSqliteClient, FakePostgresqlClient, FakeMysqlClient } = vi.hoisted(() => ({
	FakeSqliteClient: class FakeSqliteClient {},
	FakePostgresqlClient: class FakePostgresqlClient {},
	FakeMysqlClient: class FakeMysqlClient {}
}));
vi.mock('./generated/sqlite/client.ts', () => ({ PrismaClient: FakeSqliteClient }));
vi.mock('./generated/postgresql/client.ts', () => ({ PrismaClient: FakePostgresqlClient }));
vi.mock('./generated/mysql/client.ts', () => ({ PrismaClient: FakeMysqlClient }));

describe('createPrismaClient', () => {
	it('falls back to the local dev file for sqlite with no DATABASE_URL', () => {
		expect.assertions(1);

		// The zero-config default: no environment at all still starts against dev.db.
		createPrismaClient({});

		expect(createDatabaseAdapter).toHaveBeenCalledWith('sqlite', DEFAULT_SQLITE_URL, {});
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
			'postgresql://user:pass@localhost:5432/budgetpilot',
			{}
		);
	});

	it('hands the adapter a trimmed URL, not the padded one it validated', () => {
		expect.assertions(1);

		// A leading space survives .env parsing, a Compose `environment:` entry and `docker run
		// -e` alike. It used to pass the scheme check (which trims) and then miss the scheme
		// rewrite (anchored on ^), so the MariaDB driver got a string it cannot parse — and its
		// parse error quotes the whole connection string, password included.
		createPrismaClient({
			DATABASE_PROVIDER: 'mysql',
			DATABASE_URL: '  mysql://u:p@localhost:3306/b\n'
		});

		expect(createDatabaseAdapter).toHaveBeenCalledWith('mysql', 'mysql://u:p@localhost:3306/b', {});
	});

	it('treats a whitespace-only URL as unset rather than connecting to it', () => {
		expect.assertions(1);

		expect(() =>
			createPrismaClient({ DATABASE_PROVIDER: 'postgresql', DATABASE_URL: '   ' })
		).toThrow(/DATABASE_URL is required/);
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

	// The reason three clients are generated and bundled at all. A generated client embeds the
	// schema it came from and refuses an adapter that does not match it, so picking the wrong
	// one fails at connection time with an error that blames the adapter. Before this dispatch
	// existed the image shipped one SQLite client and regenerated at boot to cope.
	it.each([
		['sqlite', { DATABASE_PROVIDER: 'sqlite' }, FakeSqliteClient],
		[
			'postgresql',
			{ DATABASE_PROVIDER: 'postgresql', DATABASE_URL: 'postgresql://u:p@localhost:5432/b' },
			FakePostgresqlClient
		],
		[
			'mysql',
			{ DATABASE_PROVIDER: 'mysql', DATABASE_URL: 'mysql://u:p@localhost:3306/b' },
			FakeMysqlClient
		]
	])('constructs the client generated for %s', (_provider, env, expected) => {
		expect.assertions(1);

		expect(createPrismaClient(env)).toBeInstanceOf(expected);
	});

	// The aliases exist so an operator running MariaDB, or typing the shorter "postgres", still
	// lands on the right generated client rather than a confusing schema mismatch.
	it.each([
		[
			'postgres',
			{ DATABASE_PROVIDER: 'postgres', DATABASE_URL: 'postgres://u:p@h:5432/b' },
			FakePostgresqlClient
		],
		[
			'mariadb',
			{ DATABASE_PROVIDER: 'mariadb', DATABASE_URL: 'mariadb://u:p@h:3306/b' },
			FakeMysqlClient
		]
	])('resolves the %s alias to the right generated client', (_alias, env, expected) => {
		expect.assertions(1);

		expect(createPrismaClient(env)).toBeInstanceOf(expected);
	});
});
