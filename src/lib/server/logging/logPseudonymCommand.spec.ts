import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '$env/dynamic/private';
import { SETTINGS } from '$lib/server/env/settings';
import { logPseudonym, logSubnet } from './pseudonym';

/**
 * #942: `scripts/log-pseudonym.mjs`, the operator's way back from a log pseudonym. THE PROPERTY is
 * that it prints the value the running app writes into its log, so every expected value below comes
 * from `pseudonym.ts`'s instance functions (the ones `authn.ts` calls), under the secret the app
 * reads, never from the derivation called a second way. The command runs as a child `node` with no
 * alias resolution, exactly as it runs in the image, so a `$lib` or `$env` import in its closure
 * fails here before it fails in the container.
 *
 * The account modes need a database and are covered per engine by `logPseudonymCommand.db-smoke.ts`.
 */

const SCRIPT = resolve(import.meta.dirname, '../../../../scripts/log-pseudonym.mjs');
const SECRET = 'a1'.repeat(32);

const prefixReads = vi.hoisted(() => ({ widths: [] as number[] }));
vi.mock('$lib/server/env/readSetting', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/env/readSetting')>();
	return {
		...actual,
		readIntegerSetting: (...args: Parameters<typeof actual.readIntegerSetting>) =>
			args[0] === 'BP_RATE_LIMIT_IPV6_PREFIX' && prefixReads.widths.length > 0
				? prefixReads.widths.shift()!
				: actual.readIntegerSetting(...args)
	};
});

const saved = env.RATE_LIMIT_HASH_SECRET;
afterEach(() => {
	env.RATE_LIMIT_HASH_SECRET = saved;
	prefixReads.widths.length = 0;
});

/**
 * Runs the command in an empty working directory with no `DATABASE_URL`, so a query it ran would
 * create `dev.db` there (`provider.ts`'s default is a relative `file:./dev.db`; the adapter opens the
 * file at the first query, not when the client is built). `created` is what the directory holds
 * afterwards: empty proves the run queried no database.
 */
function run(args: string[], secret: string | undefined = SECRET, input?: string) {
	const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH };
	if (secret !== undefined) childEnv.RATE_LIMIT_HASH_SECRET = secret;
	const cwd = mkdtempSync(join(tmpdir(), 'log-pseudonym-'));
	try {
		const result = spawnSync(process.execPath, [SCRIPT, ...args], {
			cwd,
			input,
			env: childEnv,
			encoding: 'utf8',
			timeout: 20_000
		});
		return {
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			created: readdirSync(cwd)
		};
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

describe('log-pseudonym --address', () => {
	it('prints the client pseudonym the app logs, and nothing else', () => {
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		const out = run(['--address', '192.0.2.10']);
		expect(out.stderr).toBe('');
		expect(out.status).toBe(0);
		expect(out.stdout).toBe(`${logPseudonym('192.0.2.10')}\n`);
	});

	// Separates a command that canonicalises (`canonicalIpText`, as the app does) from one that
	// hashes the spelling it was given: a proxy log writes either form.
	it('gives one pseudonym for two spellings of one address', () => {
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		const expected = `${logPseudonym('2001:db8::1')}\n`;
		expect(run(['--address', '2001:DB8:0:0:0:0:0:1']).stdout).toBe(expected);
		expect(run(['--address', '2001:db8::1']).stdout).toBe(expected);
	});

	// Separates a command that trims the secret as the app does from one that keys on it raw: an
	// env_file line can carry trailing whitespace, and the app accepts it.
	// Both sides read the padded value, and both must equal the unpadded reading: a side that keys on
	// the raw text (Node's hex decoder stops at the first space, giving an empty key) differs.
	it('reads the secret as the app does, surrounding whitespace included', () => {
		const padded = ` ${SECRET}\t`;
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		const unpadded = logPseudonym('192.0.2.10');
		env.RATE_LIMIT_HASH_SECRET = padded;
		expect(logPseudonym('192.0.2.10')).toBe(unpadded);
		const out = run(['--address', '192.0.2.10'], padded);
		expect(out.stdout).toBe(`${unpadded}\n`);
	});

	it('refuses text that is not an address, and says so', () => {
		const out = run(['--address', 'not-an-address']);
		expect(out.status).toBe(2);
		expect(out.stdout).toBe('');
		expect(out.stderr).toBe('The value given to --address is not an IP address.\n');
	});
});

describe('log-pseudonym --subnet', () => {
	// The width is the one the log line carries beside the label (`subnet_prefix_length`), so the
	// operator's reading of a line reproduces it even after the setting moved.
	it('prints the subnet label the app logged at the width the line carries', () => {
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		prefixReads.widths.push(48);
		const logged = logSubnet('2001:db8:aa:bb::7');
		expect(logged.prefixLength).toBe(48);
		const out = run(['--subnet', '2001:db8:aa:bb::7', '--prefix', String(logged.prefixLength)]);
		expect(out.stderr).toBe('');
		expect(out.stdout).toBe(`${logged.pseudonym}\n`);
	});

	// Separates "the width argument is used" from "a fixed default is used": at 64 the label differs.
	it('gives a different label at a different width', () => {
		const at48 = run(['--subnet', '2001:db8:aa:bb::7', '--prefix', '48']).stdout;
		const at64 = run(['--subnet', '2001:db8:aa:bb::7', '--prefix', '64']).stdout;
		expect(at48).toMatch(/^[0-9a-f]{64}\n$/);
		expect(at64).toMatch(/^[0-9a-f]{64}\n$/);
		expect(at48).not.toBe(at64);
	});

	it('refuses a width the setting cannot hold, naming its bounds', () => {
		const { min, max } = SETTINGS.BP_RATE_LIMIT_IPV6_PREFIX;
		const out = run(['--subnet', '2001:db8::1', '--prefix', String(max + 1)]);
		expect(out.status).toBe(2);
		expect(out.stdout).toBe('');
		expect(out.stderr).toBe(`--prefix must be a whole number between ${min} and ${max}.\n`);
	});

	it('refuses a subnet query with no width, since the label depends on it', () => {
		const out = run(['--subnet', '2001:db8::1']);
		expect(out.status).toBe(2);
		expect(out.stdout).toBe('');
		expect(out.stderr).toBe(
			'--subnet needs --prefix: the width the log line carries in ' +
				'budgetpilot.client.subnet_prefix_length.\n'
		);
	});
});

describe('log-pseudonym refusals', () => {
	it('refuses a secret the app would refuse, with the app own reason', () => {
		const out = run(['--address', '192.0.2.10'], 'changeme');
		expect(out.status).toBe(2);
		expect(out.stdout).toBe('');
		expect(out.stderr).toMatch(/^RATE_LIMIT_HASH_SECRET must be exactly 64 hex characters/);
	});

	it('refuses a user pseudonym that is not 64 hex characters before reading any database', () => {
		const out = run(['--user', 'abc']);
		expect(out.status).toBe(2);
		expect(out.stdout).toBe('');
		expect(out.stderr).toBe(
			'A user pseudonym is 64 hexadecimal characters; this value is not one.\n'
		);
		expect(out.created).toEqual([]);
	});

	// Separates a command that reads the email from stdin from one that also takes it from argv,
	// which /proc and shell history keep: an email after the flag is refused, not read.
	it('refuses an email written on the command line, before reading any database', () => {
		const out = run(['--email', 'someone@example.test']);
		expect(out.status).toBe(2);
		expect(out.stdout).toBe('');
		expect(out.stderr).toBe(
			'--email reads the email from standard input, never from the command line, which ps ' +
				'and shell history keep.\n'
		);
		expect(out.created).toEqual([]);
	});

	// Separates a command that checks the email as sign-in does (`validateEmail`) from one that only
	// folds its case: a control character then reached the database, which on PostgreSQL refuses a
	// NUL and was reported as « could not be read », the wrong cause.
	it('refuses an email sign-in would refuse, before reading any database', () => {
		const out = run(['--email'], SECRET, 'a\x00b@example.test\n');
		expect(out.status).toBe(2);
		expect(out.stdout).toBe('');
		expect(out.stderr).toBe('That is not an email address an account can have.\n');
		expect(out.created).toEqual([]);
	});

	it('prints its usage when no mode is given', () => {
		const out = run([]);
		expect(out.status).toBe(2);
		expect(out.stdout).toBe('');
		for (const mode of ['--email', '--user', '--address', '--subnet', '--prefix']) {
			expect(out.stderr).toContain(mode);
		}
	});
});
