import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OperatorFacingError } from '$lib/server/operatorFacingError';
import { applySecretSources, assertSecretSourcesConfigured } from './secretSources';

/**
 * #826 part 2 and #1099, decisions 1 to 4 of the decision record: a secret arrives as a plain
 * variable or as `<NAME>_FILE`, never both, read once before the server starts. Each refusal test
 * compares the whole sentence, because the sentence is what an operator acts on.
 *
 * Real files under the home directory, not `/tmp`: strict mode refuses a file in a directory others
 * can write to, and `/tmp` is one.
 */

const KEY = 'ab'.repeat(32);
let directory: string;

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(homedir(), '.bp-secret-sources-')));
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

/** A secret file the strict mode accepts: the app's own, mode 600. */
function secretFile(name: string, content: string, mode = 0o600): string {
	const path = join(directory, name);
	writeFileSync(path, content);
	chmodSync(path, mode);
	return path;
}

/** The refusal's message, or a failure naming that nothing was refused. */
function refusal(env: NodeJS.ProcessEnv): string {
	try {
		applySecretSources(env);
	} catch (caught) {
		expect(caught).toBeInstanceOf(OperatorFacingError);
		return (caught as Error).message;
	}
	throw new Error('applySecretSources accepted the environment');
}

const heading = 'A secret could not be read from its file:\n';

describe('applySecretSources: the file form', () => {
	it('sets the variable from the file and removes the _FILE variable, as file_env unsets it', () => {
		const env: NodeJS.ProcessEnv = { TOTP_ENCRYPTION_KEY_FILE: secretFile('totp', `${KEY}\n`) };
		applySecretSources(env);
		expect(env).toEqual({ TOTP_ENCRYPTION_KEY: KEY });
	});

	it('removes trailing line endings and nothing else', () => {
		const env: NodeJS.ProcessEnv = {
			BOOTSTRAP_TOKEN_FILE: secretFile('token', ' a b \r\n\n'),
			RATE_LIMIT_HASH_SECRET_FILE: secretFile('rate', `\t${KEY}`)
		};
		applySecretSources(env);
		expect(env).toEqual({ BOOTSTRAP_TOKEN: ' a b ', RATE_LIMIT_HASH_SECRET: `\t${KEY}` });
	});

	it('reads the file when the plain variable is present but empty, as .env.example ships it', () => {
		const env: NodeJS.ProcessEnv = {
			RATE_LIMIT_HASH_SECRET: '',
			RATE_LIMIT_HASH_SECRET_FILE: secretFile('rate', KEY)
		};
		applySecretSources(env);
		expect(env).toEqual({ RATE_LIMIT_HASH_SECRET: KEY });
	});

	it('treats a file that is empty after the strip as unset, so a blank BOOTSTRAP_TOKEN stays legal', () => {
		const env: NodeJS.ProcessEnv = { BOOTSTRAP_TOKEN_FILE: secretFile('token', '\n') };
		applySecretSources(env);
		expect(env).toEqual({});
	});

	it('leaves an environment with no _FILE variable exactly as it was', () => {
		const env: NodeJS.ProcessEnv = { TOTP_ENCRYPTION_KEY: KEY, BOOTSTRAP_TOKEN: '' };
		applySecretSources(env);
		expect(env).toEqual({ TOTP_ENCRYPTION_KEY: KEY, BOOTSTRAP_TOKEN: '' });
	});

	it('reads only the four secrets the record names, never an arbitrary <NAME>_FILE', () => {
		const env: NodeJS.ProcessEnv = { ORIGIN_FILE: secretFile('origin', 'https://example.test') };
		applySecretSources(env);
		expect(env).toEqual({ ORIGIN_FILE: join(directory, 'origin') });
	});
});

describe('applySecretSources: refusals', () => {
	it('refuses both forms set, naming both variables and never the value', () => {
		const message = refusal({
			TOTP_ENCRYPTION_KEY: 'cd'.repeat(32),
			TOTP_ENCRYPTION_KEY_FILE: secretFile('totp', KEY)
		});
		expect(message).toBe(
			heading +
				'     - TOTP_ENCRYPTION_KEY and TOTP_ENCRYPTION_KEY_FILE are both set. Set one of them, so that the value the app runs with is the one you edit.'
		);
		expect(message).not.toContain('cd'.repeat(32));
		expect(message).not.toContain(KEY);
	});

	it('refuses a missing file, naming the variable and the error code', () => {
		expect(refusal({ BOOTSTRAP_TOKEN_FILE: join(directory, 'absent') })).toBe(
			heading + '     - BOOTSTRAP_TOKEN_FILE names a file that could not be read (ENOENT).'
		);
	});

	// Pass 1, F1: the configured « path » is printed nowhere, because an operator who writes the
	// value where the path belongs has written the secret there. Separates a message that quotes
	// the variable's value from one that names only the variable.
	it('never prints a _FILE value, which can be the secret itself written in the wrong place', () => {
		const message = refusal({ TOTP_ENCRYPTION_KEY_FILE: KEY });
		expect(message).toBe(
			heading + '     - TOTP_ENCRYPTION_KEY_FILE names a file that could not be read (ENOENT).'
		);
		expect(message).not.toContain(KEY);
	});

	it('lists every problem rather than stopping at the first', () => {
		const message = refusal({
			BOOTSTRAP_TOKEN_FILE: join(directory, 'absent'),
			RATE_LIMIT_HASH_SECRET: KEY,
			RATE_LIMIT_HASH_SECRET_FILE: secretFile('rate', KEY)
		});
		expect(message).toBe(
			'Secrets could not be read from their files:\n' +
				'     - RATE_LIMIT_HASH_SECRET and RATE_LIMIT_HASH_SECRET_FILE are both set. Set one of them, so that the value the app runs with is the one you edit.\n' +
				'     - BOOTSTRAP_TOKEN_FILE names a file that could not be read (ENOENT).'
		);
	});

	it('changes nothing in the environment when it refuses', () => {
		const env: NodeJS.ProcessEnv = {
			TOTP_ENCRYPTION_KEY_FILE: secretFile('totp', KEY),
			BOOTSTRAP_TOKEN_FILE: join(directory, 'absent')
		};
		const before = { ...env };
		expect(() => applySecretSources(env)).toThrow(OperatorFacingError);
		expect(env).toEqual(before);
	});
});

describe('applySecretSources: DATABASE_PASSWORD_FILE', () => {
	it('puts the password into the URL, percent-encoded, and the driver decodes the same password', () => {
		const password = 'a/b+c@d:e%f';
		const env: NodeJS.ProcessEnv = {
			DATABASE_URL: 'postgresql://budgetpilot@db.example.test:5432/budgetpilot',
			DATABASE_PASSWORD_FILE: secretFile('db', `${password}\n`)
		};
		applySecretSources(env);
		expect(env.DATABASE_PASSWORD_FILE).toBeUndefined();
		expect(env.DATABASE_PASSWORD).toBeUndefined();
		const url = new URL(env.DATABASE_URL!);
		expect(decodeURIComponent(url.password)).toBe(password);
		expect(url.password).toBe('a%2Fb%2Bc%40d%3Ae%25f');
		expect(`${url.protocol}//${url.username}@${url.host}${url.pathname}`).toBe(
			'postgresql://budgetpilot@db.example.test:5432/budgetpilot'
		);
	});

	it('works the same on a mysql:// URL', () => {
		const env: NodeJS.ProcessEnv = {
			DATABASE_URL: 'mysql://budgetpilot@mysql:3306/budgetpilot',
			DATABASE_PASSWORD_FILE: secretFile('db', KEY)
		};
		applySecretSources(env);
		expect(env.DATABASE_URL).toBe(`mysql://budgetpilot:${KEY}@mysql:3306/budgetpilot`);
	});

	it('refuses a URL that already carries a password, without printing the URL', () => {
		const message = refusal({
			DATABASE_URL: 'postgresql://budgetpilot:inline-secret@db:5432/budgetpilot',
			DATABASE_PASSWORD_FILE: secretFile('db', KEY)
		});
		expect(message).toBe(
			heading +
				'     - DATABASE_PASSWORD_FILE is set, and DATABASE_URL already carries a password. Remove the password from DATABASE_URL.'
		);
		expect(message).not.toContain('inline-secret');
	});

	// Pass 1, F5: both drivers let `?password=` override the userinfo password, so a file the app
	// read would silently lose to it.
	it('refuses a password given as a query parameter, as one inside the URL', () => {
		const message = refusal({
			DATABASE_URL: 'postgresql://budgetpilot@db:5432/budgetpilot?password=inline-secret',
			DATABASE_PASSWORD_FILE: secretFile('db', KEY)
		});
		expect(message).toBe(
			heading +
				'     - DATABASE_PASSWORD_FILE is set, and DATABASE_URL already carries a password. Remove the password from DATABASE_URL.'
		);
		expect(message).not.toContain('inline-secret');
	});

	// Pass 1, C7e: `new URL` throws a TypeError whose `input` is the whole URL.
	it('never quotes a URL it cannot parse, password included', () => {
		const message = refusal({
			DATABASE_URL: 'postgresql://budgetpilot:inline-secret@/budgetpilot',
			DATABASE_PASSWORD_FILE: secretFile('db', KEY)
		});
		expect(message).toBe(
			heading +
				'     - DATABASE_PASSWORD_FILE is set, but DATABASE_URL does not name a PostgreSQL or MySQL server to use it with.'
		);
		expect(message).not.toContain('inline-secret');
	});

	it('refuses the plain DATABASE_PASSWORD beside the file form', () => {
		expect(
			refusal({
				DATABASE_URL: 'postgresql://budgetpilot@db:5432/budgetpilot',
				DATABASE_PASSWORD: KEY,
				DATABASE_PASSWORD_FILE: secretFile('db', KEY)
			})
		).toBe(
			heading +
				'     - DATABASE_PASSWORD and DATABASE_PASSWORD_FILE are both set. Set one of them, so that the value the app runs with is the one you edit.'
		);
	});

	it.each([
		['unset', undefined],
		['a SQLite file', 'file:/data/budgetpilot.db'],
		['not a URL', 'not a url']
	])('refuses a DATABASE_URL that names no database server (%s)', (_, databaseUrl) => {
		expect(
			refusal({ DATABASE_URL: databaseUrl, DATABASE_PASSWORD_FILE: secretFile('db', KEY) })
		).toBe(
			heading +
				'     - DATABASE_PASSWORD_FILE is set, but DATABASE_URL does not name a PostgreSQL or MySQL server to use it with.'
		);
	});

	it('refuses a server URL that names no user', () => {
		expect(
			refusal({
				DATABASE_URL: 'postgresql://db:5432/budgetpilot',
				DATABASE_PASSWORD_FILE: secretFile('db', KEY)
			})
		).toBe(
			heading +
				'     - DATABASE_PASSWORD_FILE is set, but DATABASE_URL names no user for the password.'
		);
	});

	it('leaves the URL alone when the password file is empty, as for every other secret', () => {
		const env: NodeJS.ProcessEnv = {
			DATABASE_URL: 'postgresql://budgetpilot@db:5432/budgetpilot',
			DATABASE_PASSWORD_FILE: secretFile('db', '\n')
		};
		applySecretSources(env);
		expect(env).toEqual({ DATABASE_URL: 'postgresql://budgetpilot@db:5432/budgetpilot' });
	});
});

describe('applySecretSources: BP_STRICT_SECRET_FILES (decision 4)', () => {
	it('under strict, refuses a _FILE target others can read, with the #901 sentence', () => {
		const path = secretFile('totp', KEY, 0o644);
		expect(refusal({ BP_STRICT_SECRET_FILES: 'on', TOTP_ENCRYPTION_KEY_FILE: path })).toBe(
			heading +
				`     - TOTP_ENCRYPTION_KEY_FILE (${path}) can be read or written by other accounts (mode 644).`
		);
	});

	it('under strict, refuses a _FILE target reached through a symbolic link', () => {
		const target = secretFile('totp', KEY);
		const link = join(directory, 'link');
		symlinkSync(target, link);
		expect(refusal({ BP_STRICT_SECRET_FILES: 'on', TOTP_ENCRYPTION_KEY_FILE: link })).toBe(
			heading +
				`     - TOTP_ENCRYPTION_KEY_FILE (${target}) is reached through a symbolic link, so the file checked might not be the file read. Point the setting at the file itself.`
		);
	});

	it('with strict off, reads a file others can read, exactly as the bank-key file today', () => {
		const env: NodeJS.ProcessEnv = { TOTP_ENCRYPTION_KEY_FILE: secretFile('totp', KEY, 0o644) };
		applySecretSources(env);
		expect(env).toEqual({ TOTP_ENCRYPTION_KEY: KEY });
	});

	it('under strict, reads a safe file', () => {
		const env: NodeJS.ProcessEnv = {
			BP_STRICT_SECRET_FILES: 'on',
			TOTP_ENCRYPTION_KEY_FILE: secretFile('totp', KEY)
		};
		applySecretSources(env);
		expect(env).toEqual({ BP_STRICT_SECRET_FILES: 'on', TOTP_ENCRYPTION_KEY: KEY });
	});
});

describe('assertSecretSourcesConfigured: the server refuses a _FILE nothing read', () => {
	it('refuses a _FILE variable still present when the server starts, and names the entry', () => {
		expect(() =>
			assertSecretSourcesConfigured({ TOTP_ENCRYPTION_KEY_FILE: '/run/secrets/totp' })
		).toThrow(
			new OperatorFacingError(
				'TOTP_ENCRYPTION_KEY_FILE is set, but nothing read it: the file form is read when the app starts from its image. Started another way, set TOTP_ENCRYPTION_KEY itself.'
			)
		);
	});

	it('accepts an environment the resolver has already applied', () => {
		expect(() => assertSecretSourcesConfigured({ TOTP_ENCRYPTION_KEY: KEY })).not.toThrow();
	});
});
