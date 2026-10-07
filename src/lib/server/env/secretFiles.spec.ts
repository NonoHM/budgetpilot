import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSecretFilesSafe, secretFileProblems, type SecretFileFacts } from './secretFiles';

const APP_UID = 65532;

/** A file the strict mode accepts: the app's own, mode 600, in a directory only its owner writes. */
function safe(overrides: Partial<SecretFileFacts> = {}): SecretFileFacts {
	return {
		label: 'ENABLE_BANKING_PRIVATE_KEY_PATH',
		path: '/app/keys/enablebanking.pem',
		mode: 0o100600,
		uid: APP_UID,
		directoryMode: 0o40755,
		directoryUid: APP_UID,
		...overrides
	};
}

// Each case is one clause of #901's shape (an exposed file, a file another account owns, a
// directory another account can write), separated from its neighbour by one bit or one owner.
describe('secretFileProblems', () => {
	it('accepts a file the app owns, mode 600, in a directory only its owner can write', () => {
		expect(secretFileProblems([safe()], APP_UID)).toStrictEqual([]);
	});

	// OpenSSH's StrictModes accepts a file or directory owned by root as well as by the user: root
	// can replace any file anyway, so refusing it adds nothing and breaks a root-managed mount.
	it('accepts a file and a directory owned by root', () => {
		expect(secretFileProblems([safe({ uid: 0, directoryUid: 0 })], APP_UID)).toStrictEqual([]);
	});

	it.each([
		[0o100640, '640'],
		[0o100604, '604'],
		[0o100620, '620'],
		[0o100602, '602'],
		[0o100644, '644']
	])('refuses a file another account can read or write (mode %o)', (mode, octal) => {
		expect(secretFileProblems([safe({ mode })], APP_UID)).toStrictEqual([
			`ENABLE_BANKING_PRIVATE_KEY_PATH (/app/keys/enablebanking.pem) can be read or written by other accounts (mode ${octal}).`
		]);
	});

	// Execute on a key file grants nothing, so 700 is accepted rather than flagged: the warning says
	// « read or written », which an execute bit alone would make false (same rule as #906).
	it('accepts the owner execute bit', () => {
		expect(secretFileProblems([safe({ mode: 0o100700 })], APP_UID)).toStrictEqual([]);
	});

	// OpenSSH's own split (research, 2026-10-07): read bits on a file another trusted account owns
	// are how a container or a service manager hands a secret over. A Compose `file:` secret keeps the
	// host's owner and mode inside the container, and a systemd credential is root, mode 0400 plus an
	// ACL that `stat` reports as 440. Refusing their read bits would refuse a correct setup.
	it.each([
		[0o100444, 'a root-owned file readable by all, as a Compose secret mounts it'],
		[0o100440, 'a root-owned credential with a group read bit, as systemd reports it']
	])('accepts read bits on a file root owns (mode %o, %s)', (mode) => {
		expect(secretFileProblems([safe({ uid: 0, mode })], APP_UID)).toStrictEqual([]);
	});

	it('refuses write bits on a file root owns', () => {
		expect(secretFileProblems([safe({ uid: 0, mode: 0o100646 })], APP_UID)).toStrictEqual([
			'ENABLE_BANKING_PRIVATE_KEY_PATH (/app/keys/enablebanking.pem) can be changed by other accounts (mode 646).'
		]);
	});

	it('refuses a file another account owns', () => {
		expect(secretFileProblems([safe({ uid: 1000 })], APP_UID)).toStrictEqual([
			'ENABLE_BANKING_PRIVATE_KEY_PATH (/app/keys/enablebanking.pem) belongs to account 1000, not to the account the app runs as (65532).'
		]);
	});

	it.each([
		[0o40775, '775'],
		[0o40757, '757'],
		[0o41777, '1777']
	])('refuses a directory other accounts can write to (mode %o)', (directoryMode, octal) => {
		expect(secretFileProblems([safe({ directoryMode })], APP_UID)).toStrictEqual([
			`ENABLE_BANKING_PRIVATE_KEY_PATH (/app/keys/enablebanking.pem) is in a directory other accounts can write to (mode ${octal}), so they can replace it.`
		]);
	});

	it('refuses a directory another account owns', () => {
		expect(secretFileProblems([safe({ directoryUid: 1000 })], APP_UID)).toStrictEqual([
			'ENABLE_BANKING_PRIVATE_KEY_PATH (/app/keys/enablebanking.pem) is in a directory that belongs to account 1000, so that account can replace it.'
		]);
	});

	// Every problem of every file, never the first only: the boot report lists all of them.
	it('lists every problem of every file', () => {
		const env = safe({ label: '.env', path: '/srv/budgetpilot/.env', mode: 0o100644 });
		const key = safe({ uid: 1000, directoryMode: 0o40777 });
		expect(secretFileProblems([env, key], APP_UID)).toHaveLength(3);
	});
});

/**
 * The wiring, on real files: the boot check stats what the app loads and refuses on what it finds.
 * The pure cases above cannot see a check that never runs, reads the wrong file, or ignores the
 * switch. Each case is in a fresh directory of its own (mode 700, owned by the test's account), so a
 * developer's own `.env` never decides the outcome.
 */
describe.skipIf(process.platform === 'win32')('assertSecretFilesSafe', () => {
	let directory: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'bp-secret-files-'));
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	function plant(name: string, mode: number): string {
		const path = join(directory, name);
		writeFileSync(path, 'planted\n');
		chmodSync(path, mode);
		return path;
	}

	// Off is the default, and stays a warning only: the reason #901 makes this a switch is that a
	// refusal by default would stop every install whose installer wrote `.env` world-readable.
	it('does nothing while the switch is off, even over an exposed .env', () => {
		plant('.env', 0o644);
		expect(() => assertSecretFilesSafe({}, { cwd: directory })).not.toThrow();
	});

	// The calibration for the refusals below: on does not mean « always refuse ».
	it('starts with the switch on when every file belongs to the app, mode 600', () => {
		plant('.env', 0o600);
		const key = plant('enablebanking.pem', 0o600);
		const env = { BP_STRICT_SECRET_FILES: 'on', ENABLE_BANKING_PRIVATE_KEY_PATH: key };
		expect(() => assertSecretFilesSafe(env, { cwd: directory })).not.toThrow();
	});

	it('refuses an exposed .env with the switch on, naming the file and the mode', () => {
		const path = plant('.env', 0o644);
		expect(() =>
			assertSecretFilesSafe({ BP_STRICT_SECRET_FILES: 'on' }, { cwd: directory })
		).toThrow(`.env (${path}) can be read or written by other accounts (mode 644).`);
	});

	it('refuses the bank-signing key file the app loads, at the path it resolves', () => {
		const key = plant('enablebanking.pem', 0o640);
		const env = { BP_STRICT_SECRET_FILES: 'on', ENABLE_BANKING_PRIVATE_KEY_PATH: key };
		expect(() => assertSecretFilesSafe(env, { cwd: directory })).toThrow(
			`ENABLE_BANKING_PRIVATE_KEY_PATH (${key}) can be read or written by other accounts (mode 640).`
		);
	});

	// A file that exists but cannot be inspected is not « absent »: in strict mode it is refused,
	// unlike the warning path, which treats a failed stat as no file (#906's `envFileMode.ts`).
	// A directory without the search bit makes `stat` of a file inside it fail with EACCES.
	it.skipIf(process.getuid?.() === 0)(
		'refuses a key file it cannot inspect, rather than treating it as absent',
		() => {
			const locked = join(directory, 'locked');
			mkdirSync(locked);
			const key = join(locked, 'enablebanking.pem');
			writeFileSync(key, 'planted\n');
			chmodSync(locked, 0o600);
			try {
				const env = { BP_STRICT_SECRET_FILES: 'on', ENABLE_BANKING_PRIVATE_KEY_PATH: key };
				expect(() => assertSecretFilesSafe(env, { cwd: directory })).toThrow(
					`ENABLE_BANKING_PRIVATE_KEY_PATH (${key}) could not be inspected (EACCES).`
				);
			} finally {
				chmodSync(locked, 0o700);
			}
		}
	);

	it('refuses a value of the switch it does not know, rather than reading it as off', () => {
		expect(() =>
			assertSecretFilesSafe({ BP_STRICT_SECRET_FILES: 'yes' }, { cwd: directory })
		).toThrow('BP_STRICT_SECRET_FILES must be one of off, on (got "yes").');
	});
});
