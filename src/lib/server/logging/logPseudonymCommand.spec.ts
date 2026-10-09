import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
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

function run(args: string[], secret: string | undefined = SECRET) {
	const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH };
	if (secret !== undefined) childEnv.RATE_LIMIT_HASH_SECRET = secret;
	const result = spawnSync(process.execPath, [SCRIPT, ...args], {
		env: childEnv,
		encoding: 'utf8',
		timeout: 20_000
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
	it('reads the secret as the app does, surrounding whitespace included', () => {
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		const out = run(['--address', '192.0.2.10'], ` ${SECRET}\t`);
		expect(out.stdout).toBe(`${logPseudonym('192.0.2.10')}\n`);
	});

	it('refuses text that is not an address, and says so', () => {
		const out = run(['--address', 'not-an-address']);
		expect(out.status).not.toBe(0);
		expect(out.stdout).toBe('');
		expect(out.stderr).toContain('is not an IP address');
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
		expect(out.status).not.toBe(0);
		expect(out.stdout).toBe('');
		expect(out.stderr).toContain(`between ${min} and ${max}`);
	});

	it('refuses a subnet query with no width, since the label depends on it', () => {
		const out = run(['--subnet', '2001:db8::1']);
		expect(out.status).not.toBe(0);
		expect(out.stdout).toBe('');
		expect(out.stderr).toContain('--prefix');
	});
});

describe('log-pseudonym refusals', () => {
	it('refuses a secret the app would refuse, with the app own reason', () => {
		const out = run(['--address', '192.0.2.10'], 'changeme');
		expect(out.status).not.toBe(0);
		expect(out.stdout).toBe('');
		expect(out.stderr).toContain('RATE_LIMIT_HASH_SECRET must be exactly 64 hex characters');
	});

	it('refuses a user pseudonym that is not 64 hex characters before reading any database', () => {
		const out = run(['--user', 'abc']);
		expect(out.status).not.toBe(0);
		expect(out.stdout).toBe('');
		expect(out.stderr).toContain('64 hexadecimal characters');
	});

	it('prints its usage when no mode is given', () => {
		const out = run([]);
		expect(out.status).not.toBe(0);
		expect(out.stdout).toBe('');
		expect(out.stderr).toContain('--email');
	});
});
