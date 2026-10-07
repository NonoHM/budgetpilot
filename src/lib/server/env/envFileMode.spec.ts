import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exposedEnvFileMode, readEnvFileMode } from './envFileMode';

/**
 * The boot warning's decision (#826): which modes of `.env` another local account can use.
 * Each case names the mode it is the boundary for.
 */
describe('exposedEnvFileMode', () => {
	it.each([
		{ mode: 0o600, octal: '600', why: 'owner read and write, the mode setup writes' },
		{ mode: 0o400, octal: '400', why: 'owner read only' },
		{ mode: 0o700, octal: '700', why: 'owner execute, which no other account gains anything from' },
		// Execute on a dotenv file grants nothing: nobody runs it, and without read it cannot be.
		{ mode: 0o610, octal: '610', why: 'group execute alone' },
		{ mode: 0o601, octal: '601', why: 'world execute alone' }
	])('stays silent on $octal ($why)', ({ mode }) => {
		expect(exposedEnvFileMode(mode, 'linux')).toBeNull();
	});

	// The read bits are the confidentiality half. The write bits are the integrity half, and the
	// ones a mask over the read bits alone would miss: another account that can write .env can set
	// DATABASE_URL or ORIGIN.
	it.each([
		{ mode: 0o640, octal: '640', why: 'group read' },
		{ mode: 0o604, octal: '604', why: 'world read' },
		{ mode: 0o620, octal: '620', why: 'group write' },
		{ mode: 0o602, octal: '602', why: 'world write' },
		{ mode: 0o644, octal: '644', why: 'the mode setup used to write' }
	])('warns on $octal and reports it in octal ($why)', ({ mode, octal }) => {
		expect(exposedEnvFileMode(mode, 'linux')).toBe(octal);
	});

	it('reads the permission bits of a full stat mode, file type included', () => {
		// statSync().mode carries S_IFREG (0o100000) above the permission bits.
		expect([exposedEnvFileMode(0o100644, 'linux'), exposedEnvFileMode(0o100600, 'linux')]).toEqual([
			'644',
			null
		]);
	});

	it('has nothing to decide when there is no .env', () => {
		expect(exposedEnvFileMode(null, 'linux')).toBeNull();
	});

	it('stays silent on Windows, where these bits do not describe who can read the file', () => {
		expect([exposedEnvFileMode(0o644, 'win32'), exposedEnvFileMode(0o644, 'darwin')]).toEqual([
			null,
			'644'
		]);
	});
});

describe('readEnvFileMode', () => {
	let directory = '';
	afterEach(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
		directory = '';
	});

	it('reads the mode of the .env in the given directory, and null when there is none', () => {
		directory = mkdtempSync(join(tmpdir(), 'env-mode-'));
		const absent = readEnvFileMode(directory);
		writeFileSync(join(directory, '.env'), 'X=1\n');
		chmodSync(join(directory, '.env'), 0o640);

		const present = readEnvFileMode(directory);

		expect([absent, present === null ? null : present & 0o777]).toEqual([null, 0o640]);
	});
});
