import { describe, expect, it } from 'vitest';
import {
	assertDatabaseUrlMatchesProvider,
	IMAGE_DATABASE_URL,
	LEGACY_IMAGE_DATABASE_URL,
	migrationsPathFor,
	normalizeDatabaseUrl,
	resolveDatabaseProvider,
	resolveImageDatabaseUrl,
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

/**
 * #957: the image's database path and the one it replaced. `boot.mjs` used to hold this rule alone
 * and record its answer only in its own process, so every other reader in the image (a script run
 * with `docker compose exec` or `run --rm`, the Prisma CLI) opened the new path, and opening a
 * missing SQLite path creates it at 0 bytes: the next restart then found the new file and served it
 * empty. Each case below separates one situation from its neighbours. A volume is a map from path
 * to size in bytes; a path it does not hold is absent.
 */
describe('resolveImageDatabaseUrl', () => {
	const NEW_PATH = IMAGE_DATABASE_URL.slice('file:'.length);
	const LEGACY_PATH = LEGACY_IMAGE_DATABASE_URL.slice('file:'.length);
	const volume = (files: Record<string, number>) => (path: string) => files[path];

	it('opens the legacy file on an upgraded volume that holds only it', () => {
		expect(resolveImageDatabaseUrl(IMAGE_DATABASE_URL, volume({ [LEGACY_PATH]: 8192 }))).toEqual({
			databaseUrl: LEGACY_IMAGE_DATABASE_URL,
			situation: 'legacy-adopted'
		});
	});

	// The state every door that opens a missing path leaves behind: a pre-fix dry run, a `node:sqlite`
	// line, any later one. A database with a table, or in WAL mode before any checkpoint, has at
	// least one 4096-byte page in its main file, so 0 bytes holds nothing. Separates "absent or
	// empty" from "absent": the second served this file at the next restart.
	it('opens the legacy file over an empty file at the new path, which holds no database', () => {
		expect(
			resolveImageDatabaseUrl(IMAGE_DATABASE_URL, volume({ [NEW_PATH]: 0, [LEGACY_PATH]: 8192 }))
		).toEqual({ databaseUrl: LEGACY_IMAGE_DATABASE_URL, situation: 'legacy-adopted-over-empty' });
	});

	// Padding survives an env_file line; the client trims it, so the rule must read the same value
	// the client connects with, or the two disagree about which file this is.
	it('reads the configured value as the client does, padding included', () => {
		expect(
			resolveImageDatabaseUrl(` ${IMAGE_DATABASE_URL}\t`, volume({ [LEGACY_PATH]: 8192 }))
		).toEqual({ databaseUrl: LEGACY_IMAGE_DATABASE_URL, situation: 'legacy-adopted' });
	});

	// The boundary of the empty case: one page is a database. Both files then hold one and no rule
	// can tell which the owner means, so the configured file stays open and the sizes travel with the
	// answer for boot to report (owner's ruling on #957: keep it, warn every boot).
	it('keeps the new file once it holds a database, and reports both sizes', () => {
		expect(
			resolveImageDatabaseUrl(IMAGE_DATABASE_URL, volume({ [NEW_PATH]: 4096, [LEGACY_PATH]: 8192 }))
		).toEqual({
			databaseUrl: IMAGE_DATABASE_URL,
			situation: 'both-hold-a-database',
			imageBytes: 4096,
			legacyBytes: 8192
		});
	});

	it('keeps the new path on a new install, where there is nothing to adopt', () => {
		expect(resolveImageDatabaseUrl(IMAGE_DATABASE_URL, volume({}))).toEqual({
			databaseUrl: IMAGE_DATABASE_URL,
			situation: 'image'
		});
	});

	it('gives an operator who set another path exactly that path', () => {
		expect(resolveImageDatabaseUrl('file:/data/mine.db', volume({ [LEGACY_PATH]: 8192 }))).toEqual({
			databaseUrl: 'file:/data/mine.db',
			situation: 'configured'
		});
	});

	// An unset URL is the development default, never the image's: outside the image the legacy
	// path means nothing, and this reader must not invent the image path for it.
	it('leaves an unset URL unset', () => {
		expect(resolveImageDatabaseUrl(undefined, volume({ [LEGACY_PATH]: 8192 }))).toEqual({
			databaseUrl: undefined,
			situation: 'configured'
		});
	});
});
