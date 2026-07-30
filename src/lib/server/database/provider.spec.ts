import { describe, expect, it } from 'vitest';
import {
	assertDatabaseUrlMatchesProvider,
	migrationsPathFor,
	normalizeDatabaseUrl,
	resolveDatabaseProvider,
	schemaPathFor,
	toDriverConnectionUrl,
	toPrismaConnectionUrl
} from './provider';

describe('resolveDatabaseProvider', () => {
	it.each([
		['unset', undefined],
		['empty', ''],
		['whitespace only', '   ']
	])('defaults to sqlite when DATABASE_PROVIDER is %s', (_label, value) => {
		expect.assertions(1);

		// The zero-config default: an install that predates multi-database support keeps
		// running exactly as it did.
		expect(resolveDatabaseProvider({ DATABASE_PROVIDER: value })).toBe('sqlite');
	});

	it.each([
		['sqlite', 'sqlite'],
		['postgresql', 'postgresql'],
		['postgres', 'postgresql'],
		['mysql', 'mysql'],
		['mariadb', 'mysql'],
		['  PostgreSQL  ', 'postgresql']
	])('resolves %s to %s', (value, expected) => {
		expect.assertions(1);

		expect(resolveDatabaseProvider({ DATABASE_PROVIDER: value })).toBe(expected);
	});

	it('throws on an unrecognised provider instead of falling back', () => {
		expect.assertions(1);

		// Falling back to sqlite would start the app against an empty local file while the
		// operator's real database sat untouched, and every screen would report no data.
		expect(() => resolveDatabaseProvider({ DATABASE_PROVIDER: 'postgres_' })).toThrow(
			/not a supported database/
		);
	});
});

describe('normalizeDatabaseUrl', () => {
	it.each([
		['a leading space', ' mysql://u:p@h:3306/bp'],
		['a trailing newline', 'mysql://u:p@h:3306/bp\n'],
		['both', '  mysql://u:p@h:3306/bp  ']
	])('strips %s', (_label, url) => {
		expect.assertions(1);

		expect(normalizeDatabaseUrl(url)).toBe('mysql://u:p@h:3306/bp');
	});

	it.each([
		['unset', undefined],
		['empty', ''],
		['whitespace only', '   ']
	])('treats %s as unset', (_label, url) => {
		expect.assertions(1);

		// Not "  " surviving as a truthy string: every caller checks `!databaseUrl` to decide
		// whether the operator configured one at all, and whitespace is not a configuration.
		expect(normalizeDatabaseUrl(url)).toBeUndefined();
	});

	it('leaves an already-clean URL identical', () => {
		expect.assertions(1);

		expect(normalizeDatabaseUrl('postgresql://u:p@h:5432/bp')).toBe('postgresql://u:p@h:5432/bp');
	});

	// The reason this function exists, stated as a test. The scheme check trims, both scheme
	// rewrites are `^`-anchored and do not — so a padded URL passed validation as mysql:// and
	// then missed the rewrite, reaching the MariaDB driver's parse error, which is the one
	// error path that interpolates the whole connection string. A space leaked the password.
	it('closes the gap between what is validated and what is rewritten', () => {
		expect.assertions(3);

		const padded = ' mysql://admin:hunter2@db.internal:3306/bp';

		// Without normalising: validation passes, the rewrite misses.
		expect(() => assertDatabaseUrlMatchesProvider('mysql', padded)).not.toThrow();
		expect(toDriverConnectionUrl('mysql', padded)).toBe(padded);

		// With it, the two agree again.
		expect(toDriverConnectionUrl('mysql', normalizeDatabaseUrl(padded)!)).toBe(
			'mariadb://admin:hunter2@db.internal:3306/bp'
		);
	});
});

describe('assertDatabaseUrlMatchesProvider', () => {
	it.each([
		['sqlite', 'file:./dev.db'],
		['sqlite', 'file:/data/budgetpilot.db'],
		['postgresql', 'postgresql://user:pass@localhost:5432/budgetpilot'],
		['postgresql', 'postgres://user:pass@localhost:5432/budgetpilot'],
		['mysql', 'mysql://user:pass@localhost:3306/budgetpilot'],
		['mysql', 'mariadb://user:pass@localhost:3306/budgetpilot']
	] as const)('accepts a %s URL', (provider, url) => {
		expect.assertions(1);

		expect(() => assertDatabaseUrlMatchesProvider(provider, url)).not.toThrow();
	});

	it("accepts a missing URL, which is another layer's decision", () => {
		expect.assertions(1);

		expect(() => assertDatabaseUrlMatchesProvider('postgresql', undefined)).not.toThrow();
	});

	it('rejects a URL belonging to another engine', () => {
		expect.assertions(1);

		expect(() => assertDatabaseUrlMatchesProvider('postgresql', 'file:./dev.db')).toThrow(
			/does not match/
		);
	});

	it('never quotes anything but the scheme of the rejected URL', () => {
		expect.assertions(2);

		// DATABASE_URL carries the database password: it must never reach a log or an error
		// message, and an error message is the likeliest place for it to leak.
		const url = 'mysql://admin:hunter2@db.internal:3306/budgetpilot';

		expect(() => assertDatabaseUrlMatchesProvider('postgresql', url)).toThrow(/"mysql" scheme/);
		try {
			assertDatabaseUrlMatchesProvider('postgresql', url);
		} catch (caught) {
			expect((caught as Error).message).not.toContain('hunter2');
		}
	});

	it('rejects a URL with no scheme at all', () => {
		expect.assertions(1);

		expect(() => assertDatabaseUrlMatchesProvider('postgresql', '/var/lib/pg/budgetpilot')).toThrow(
			/does not match/
		);
	});
});

describe('toDriverConnectionUrl', () => {
	it('rewrites a mysql:// URL to the only scheme the MariaDB driver parses', () => {
		expect.assertions(1);

		expect(toDriverConnectionUrl('mysql', 'mysql://user:pass@localhost:3306/budgetpilot')).toBe(
			'mariadb://user:pass@localhost:3306/budgetpilot'
		);
	});

	it('changes nothing but the scheme', () => {
		expect.assertions(1);

		// Credentials, host, database and query parameters must survive verbatim: a mangled
		// password would surface as an authentication failure that names the wrong problem.
		expect(
			toDriverConnectionUrl('mysql', 'mysql://u:p%40ss@db.internal:3306/bp?connectTimeout=5000')
		).toBe('mariadb://u:p%40ss@db.internal:3306/bp?connectTimeout=5000');
	});

	it('leaves an already-mariadb:// URL alone', () => {
		expect.assertions(1);

		expect(toDriverConnectionUrl('mysql', 'mariadb://user@localhost/bp')).toBe(
			'mariadb://user@localhost/bp'
		);
	});

	it.each([
		['sqlite', 'file:./dev.db'],
		['postgresql', 'postgresql://user@localhost/bp']
	] as const)('leaves a %s URL untouched', (provider, url) => {
		expect.assertions(1);

		expect(toDriverConnectionUrl(provider, url)).toBe(url);
	});
});

describe('toPrismaConnectionUrl', () => {
	it('rewrites a mariadb:// URL to the only scheme the Prisma CLI parses', () => {
		expect.assertions(1);

		// The failure this prevents: `DATABASE_PROVIDER=mariadb` with a matching `mariadb://`
		// URL passed every check this module makes, then killed the container at
		// `migrate deploy` with P1013 — an error naming neither variable.
		expect(toPrismaConnectionUrl('mysql', 'mariadb://user:pass@localhost:3306/budgetpilot')).toBe(
			'mysql://user:pass@localhost:3306/budgetpilot'
		);
	});

	it('changes nothing but the scheme', () => {
		expect.assertions(1);

		expect(
			toPrismaConnectionUrl('mysql', 'mariadb://u:p%40ss@db.internal:3306/bp?connectTimeout=5000')
		).toBe('mysql://u:p%40ss@db.internal:3306/bp?connectTimeout=5000');
	});

	it('leaves an already-mysql:// URL alone', () => {
		expect.assertions(1);

		expect(toPrismaConnectionUrl('mysql', 'mysql://user@localhost/bp')).toBe(
			'mysql://user@localhost/bp'
		);
	});

	it.each([
		['sqlite', 'file:./dev.db'],
		['postgresql', 'postgresql://user@localhost/bp']
	] as const)('leaves a %s URL untouched', (provider, url) => {
		expect.assertions(1);

		expect(toPrismaConnectionUrl(provider, url)).toBe(url);
	});

	it('inverts toDriverConnectionUrl exactly', () => {
		expect.assertions(2);

		// The two rewrites are mirror images, and a round trip through both must land back on
		// the operator's original string. If either drifts, one of the two consumers silently
		// starts talking to the wrong scheme.
		const mysqlUrl = 'mysql://u:p@h:3306/bp';
		const mariadbUrl = 'mariadb://u:p@h:3306/bp';

		expect(toPrismaConnectionUrl('mysql', toDriverConnectionUrl('mysql', mysqlUrl))).toBe(mysqlUrl);
		expect(toDriverConnectionUrl('mysql', toPrismaConnectionUrl('mysql', mariadbUrl))).toBe(
			mariadbUrl
		);
	});
});

describe('schemaPathFor', () => {
	it('keeps sqlite on the default filename', () => {
		expect.assertions(1);

		// So `npx prisma migrate dev` and every editor extension keep working with no
		// arguments for the setup almost everyone runs.
		expect(schemaPathFor('sqlite')).toBe('prisma/schema.prisma');
	});

	it.each([
		['postgresql', 'prisma/schema.postgresql.prisma'],
		['mysql', 'prisma/schema.mysql.prisma']
	] as const)('points %s at its generated schema', (provider, expected) => {
		expect.assertions(1);

		expect(schemaPathFor(provider)).toBe(expected);
	});
});

describe('migrationsPathFor', () => {
	it.each(['sqlite', 'postgresql', 'mysql'] as const)('gives %s its own history', (provider) => {
		expect.assertions(1);

		// Never a shared directory: the same logical change is different SQL on each engine,
		// and Prisma records only a migration's name as applied.
		expect(migrationsPathFor(provider)).toBe(`prisma/migrations/${provider}`);
	});
});
