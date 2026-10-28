import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ATTRIBUTE, EVENT } from '$lib/server/logging/names';

/**
 * #826/#1099 decision 3: `boot.mjs` resolves `<NAME>_FILE` BEFORE `prisma migrate deploy`, which is
 * the first thing that reads a secret (the database URL). Run as the image runs it, a child `node`
 * with no alias resolution, so a `$lib` import in the resolver's closure fails here first.
 *
 * The observation is the SQLite file: `migrate deploy` creates it. Absent after a refusal means the
 * refusal came first; the calibration below shows the same observation reads « present » when
 * nothing refuses.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const KEY = 'ab'.repeat(32);
/** Each test spawns a real `node`, and a migration under the full suite's load outlasts vitest's 5 s. */
const SPAWN_TIMEOUT_MS = 60_000;
let directory: string;

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(homedir(), '.bp-boot-secrets-')));
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function boot(extra: NodeJS.ProcessEnv) {
	const database = join(directory, 'boot.db');
	const result = spawnSync(process.execPath, ['boot.mjs'], {
		cwd: ROOT,
		env: {
			PATH: process.env.PATH,
			DATABASE_PROVIDER: 'sqlite',
			DATABASE_URL: `file:${database}`,
			...extra
		},
		encoding: 'utf8',
		timeout: 60_000
	});
	return { ...result, migrated: existsSync(database) };
}

describe('boot.mjs and the file form', () => {
	it(
		'refuses both forms of a secret before the migration runs, as one boot_secrets_refused line',
		() => {
			const file = join(directory, 'totp');
			writeFileSync(file, KEY, { mode: 0o600 });
			const out = boot({ TOTP_ENCRYPTION_KEY: KEY, TOTP_ENCRYPTION_KEY_FILE: file });
			expect(out.status).toBe(1);
			expect(out.migrated).toBe(false);
			const lines = out.stdout
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			const crash = lines.filter((line) => line.event_name === EVENT.bootSecretsRefused);
			expect(crash).toHaveLength(1);
			expect(crash[0][ATTRIBUTE.errorOperatorMessage]).toBe(
				'A secret could not be read from its file:\n     - TOTP_ENCRYPTION_KEY and TOTP_ENCRYPTION_KEY_FILE are both set. Set one of them, so that the value the app runs with is the one you edit.'
			);
			expect(out.stdout).not.toContain(KEY);
			expect(out.stderr).not.toContain(KEY);
		},
		SPAWN_TIMEOUT_MS
	);

	// Calibration for `migrated`: with nothing to refuse, the migration creates the file. What
	// happens after it (the server import) is not this spec's subject.
	it(
		'runs the migration when the file form is the only form',
		() => {
			const file = join(directory, 'totp');
			writeFileSync(file, KEY, { mode: 0o600 });
			expect(boot({ TOTP_ENCRYPTION_KEY_FILE: file }).migrated).toBe(true);
		},
		SPAWN_TIMEOUT_MS
	);
});

/**
 * Pass 1, F2: `docs/operations.md` sends an operator to the Prisma CLI by its file
 * (`docker compose run --rm budgetpilot node_modules/prisma/build/index.js migrate resolve`), which
 * replaces the image's command, so `boot.mjs` never runs. `prisma.config.ts` is what that CLI loads,
 * so it resolves too. Separates a config that calls the resolver from one that reads the bare
 * variables: only the first refuses the contradictory pair.
 */
describe('prisma.config.ts and the file form', () => {
	function prisma(extra: NodeJS.ProcessEnv) {
		return spawnSync(
			process.execPath,
			['node_modules/prisma/build/index.js', 'migrate', 'status'],
			{
				cwd: ROOT,
				env: {
					PATH: process.env.PATH,
					DATABASE_PROVIDER: 'sqlite',
					DATABASE_URL: `file:${join(directory, 'cli.db')}`,
					CHECKPOINT_DISABLE: '1',
					...extra
				},
				encoding: 'utf8',
				timeout: 60_000
			}
		);
	}

	it(
		'refuses both forms of a secret when the CLI is run directly',
		() => {
			const file = join(directory, 'totp');
			writeFileSync(file, KEY, { mode: 0o600 });
			const out = prisma({ TOTP_ENCRYPTION_KEY: KEY, TOTP_ENCRYPTION_KEY_FILE: file });
			expect(out.status).not.toBe(0);
			expect(`${out.stdout}${out.stderr}`).toContain(
				'TOTP_ENCRYPTION_KEY and TOTP_ENCRYPTION_KEY_FILE are both set.'
			);
			expect(`${out.stdout}${out.stderr}`).not.toContain(KEY);
		},
		SPAWN_TIMEOUT_MS
	);

	// Pass 2B, finding 2: a CLI run outside the image takes DATABASE_URL from `.env`, which the config
	// loads itself. Separates a config that resolves after that load (the password file meets the
	// URL, and the CLI gets as far as the connection) from one that resolves before it (« does not
	// name a ... server », a refusal of a URL that is there).
	it(
		'resolves the password file against a DATABASE_URL the config read from .env',
		() => {
			writeFileSync(
				join(directory, '.env'),
				'DATABASE_PROVIDER=postgresql\nDATABASE_URL=postgresql://bp@127.0.0.1:1/bp\n'
			);
			const file = join(directory, 'db');
			writeFileSync(file, 'pw\n', { mode: 0o600 });
			const out = spawnSync(
				process.execPath,
				[
					join(ROOT, 'node_modules/prisma/build/index.js'),
					'migrate',
					'status',
					'--config',
					join(ROOT, 'prisma.config.ts')
				],
				{
					cwd: directory,
					env: { PATH: process.env.PATH, CHECKPOINT_DISABLE: '1', DATABASE_PASSWORD_FILE: file },
					encoding: 'utf8',
					timeout: 60_000
				}
			);
			const output = `${out.stdout}${out.stderr}`;
			expect(output).not.toContain('A secret could not be read');
			expect(output).toContain('127.0.0.1:1');
		},
		SPAWN_TIMEOUT_MS
	);

	// Calibration for the assertion above: the same run with one form prints no refusal.
	it(
		'prints no refusal with the file form alone',
		() => {
			const file = join(directory, 'totp');
			writeFileSync(file, KEY, { mode: 0o600 });
			const out = prisma({ TOTP_ENCRYPTION_KEY_FILE: file });
			expect(`${out.stdout}${out.stderr}`).not.toContain('are both set');
			expect(`${out.stdout}${out.stderr}`).toContain('Datasource');
		},
		SPAWN_TIMEOUT_MS
	);
});

/**
 * `scripts/normalize-names.mjs` resolves before it builds its client, so `docker compose exec` with
 * DATABASE_PASSWORD_FILE reaches the same database the app does. Separates a script that calls the
 * resolver from one that does not: only the first refuses the contradictory pair.
 */
describe('normalize-names.mjs and the file form', () => {
	it(
		'refuses both forms of a secret before it opens the database',
		() => {
			const file = join(directory, 'totp');
			writeFileSync(file, KEY, { mode: 0o600 });
			const database = join(directory, 'names.db');
			const out = spawnSync(process.execPath, ['scripts/normalize-names.mjs', '--dry-run'], {
				cwd: ROOT,
				env: {
					PATH: process.env.PATH,
					DATABASE_PROVIDER: 'sqlite',
					DATABASE_URL: `file:${database}`,
					TOTP_ENCRYPTION_KEY: KEY,
					TOTP_ENCRYPTION_KEY_FILE: file
				},
				encoding: 'utf8',
				timeout: 60_000
			});
			expect(out.status).toBe(1);
			expect(out.stderr).toBe(
				'Name normalization failed: A secret could not be read from its file:\n     - TOTP_ENCRYPTION_KEY and TOTP_ENCRYPTION_KEY_FILE are both set. Set one of them, so that the value the app runs with is the one you edit.\n'
			);
			expect(existsSync(database)).toBe(false);
		},
		SPAWN_TIMEOUT_MS
	);
});
