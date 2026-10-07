import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertSecretFilesSafe, secretFileProblems, type SecretFileFacts } from './secretFiles';

const APP_UID = 65532;

/**
 * A file the strict mode accepts: the app's own, mode 600, reached without a link, in a directory
 * only the app writes, under directories root owns, nearest first, up to `/`.
 */
function safe(overrides: Partial<SecretFileFacts> = {}): SecretFileFacts {
	return {
		label: 'ENABLE_BANKING_PRIVATE_KEY_PATH',
		path: '/app/keys/enablebanking.pem',
		mode: 0o100600,
		uid: APP_UID,
		throughLink: false,
		directories: [
			{ path: '/app/keys', mode: 0o40755, uid: APP_UID },
			{ path: '/app', mode: 0o40755, uid: 0 },
			{ path: '/', mode: 0o40755, uid: 0 }
		],
		...overrides
	};
}

/** `safe()` with the nearest directory changed. */
function nearest(change: { mode?: number; uid?: number }): Partial<SecretFileFacts> {
	const [first, ...rest] = safe().directories;
	return { directories: [{ ...first, ...change }, ...rest] };
}

/** `safe()` with the directory above the nearest changed. */
function ancestor(change: { mode?: number; uid?: number }): Partial<SecretFileFacts> {
	const [first, second, ...rest] = safe().directories;
	return { directories: [first, { ...second, ...change }, ...rest] };
}

const WHERE = 'ENABLE_BANKING_PRIVATE_KEY_PATH (/app/keys/enablebanking.pem)';

// Each case is one clause of #901's shape (an exposed file, a file another account owns, a
// directory another account can write), separated from its neighbour by one bit or one owner.
describe('secretFileProblems', () => {
	it('accepts a file the app owns, mode 600, in a directory only its owner can write', () => {
		expect(secretFileProblems([safe()], APP_UID)).toStrictEqual([]);
	});

	// OpenSSH's StrictModes accepts a file or directory owned by root as well as by the user: root
	// can replace any file anyway, so refusing it adds nothing and breaks a root-managed mount.
	it('accepts a file and a directory owned by root', () => {
		expect(secretFileProblems([safe({ uid: 0, ...nearest({ uid: 0 }) })], APP_UID)).toStrictEqual(
			[]
		);
	});

	it.each([
		[0o100640, '640'],
		[0o100604, '604'],
		[0o100620, '620'],
		[0o100602, '602'],
		[0o100644, '644']
	])('refuses a file another account can read or write (mode %o)', (mode, octal) => {
		expect(secretFileProblems([safe({ mode })], APP_UID)).toStrictEqual([
			`${WHERE} can be read or written by other accounts (mode ${octal}).`
		]);
	});

	// Execute on a key file grants nothing, so 700 is accepted rather than flagged: the warning says
	// « read or written », which an execute bit alone would make false (same rule as #906).
	it('accepts the owner execute bit', () => {
		expect(secretFileProblems([safe({ mode: 0o100700 })], APP_UID)).toStrictEqual([]);
	});

	// A systemd credential is root, mode 0400 plus an ACL for the unit's user, which `stat` reports
	// as 440 (the group bits show the ACL mask). Group read on a file root owns is accepted for that.
	it('accepts group read on a file root owns, as systemd reports a credential (mode 440)', () => {
		expect(secretFileProblems([safe({ uid: 0, mode: 0o100440 })], APP_UID)).toStrictEqual([]);
	});

	// Read for OTHERS is refused whoever owns the file: a root-owned 644 secret is what `sudo cp`
	// leaves, and every account on the host can read it (contradiction pass on #915). OpenSSH
	// accepts it for an authorized_keys file, which is not a secret; this is.
	it.each([
		[0o100644, '644', 'a root-owned file every account can read, as sudo cp leaves it'],
		[0o100444, '444', 'a Compose file secret mounted root, mode 444']
	])('refuses read for others on a file root owns (mode %o, %s)', (mode, octal) => {
		expect(secretFileProblems([safe({ uid: 0, mode })], APP_UID)).toStrictEqual([
			`${WHERE} can be read by other accounts (mode ${octal}).`
		]);
	});

	it('refuses write bits on a file root owns', () => {
		expect(secretFileProblems([safe({ uid: 0, mode: 0o100646 })], APP_UID)).toStrictEqual([
			`${WHERE} can be changed by other accounts (mode 646).`
		]);
	});

	it('refuses a file another account owns', () => {
		expect(secretFileProblems([safe({ uid: 1000 })], APP_UID)).toStrictEqual([
			`${WHERE} belongs to account 1000, not to the account the app runs as (65532).`
		]);
	});

	it.each([
		[0o40775, '775'],
		[0o40757, '757'],
		[0o41777, '1777']
	])('refuses a directory other accounts can write to (mode %o)', (mode, octal) => {
		expect(secretFileProblems([safe(nearest({ mode }))], APP_UID)).toStrictEqual([
			`${WHERE} is in a directory other accounts can write to (mode ${octal}), so they can replace it.`
		]);
	});

	it('refuses a directory another account owns', () => {
		expect(secretFileProblems([safe(nearest({ uid: 1000 }))], APP_UID)).toStrictEqual([
			`${WHERE} is in a directory that belongs to account 1000, so that account can replace it.`
		]);
	});

	// Every directory up to `/`, as OpenSSH walks it: whoever can write a directory higher up can
	// rename the branch below it and put another file in its place (security review of #915).
	it('refuses a directory higher up that other accounts can write to', () => {
		expect(secretFileProblems([safe(ancestor({ mode: 0o40777 }))], APP_UID)).toStrictEqual([
			`${WHERE} is under /app, which other accounts can write to (mode 777), so they can replace it.`
		]);
	});

	it('refuses a directory higher up that another account owns', () => {
		expect(secretFileProblems([safe(ancestor({ uid: 1000 }))], APP_UID)).toStrictEqual([
			`${WHERE} is under /app, which belongs to account 1000, so that account can replace it.`
		]);
	});

	// A link anywhere on the path is refused rather than followed: the link can be repointed between
	// the check and the read, and judging only its target, or only its own directory, each left a
	// way round (two security reviews of #915).
	it('refuses a file reached through a symbolic link', () => {
		expect(secretFileProblems([safe({ throughLink: true })], APP_UID)).toStrictEqual([
			`${WHERE} is reached through a symbolic link, so the file checked might not be the file read. Point the setting at the file itself.`
		]);
	});

	// Every problem of every file, never the first only: the boot report lists all of them.
	it('lists every problem of every file', () => {
		const env = safe({ label: '.env', path: '/srv/budgetpilot/.env', mode: 0o100644 });
		const key = safe({ uid: 1000, ...nearest({ mode: 0o40777 }) });
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
		// Under the home directory, not the system temporary one: the check walks every directory up
		// to `/`, and `/tmp` is writable by every account, so a file under it is rightly refused.
		// Real path: the check reports a file at its resolved path, and a home can sit behind a link.
		directory = realpathSync(mkdtempSync(join(homedir(), '.bp-secret-files-')));
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

	// A link is refused rather than followed, wherever it points: two earlier rules (the target
	// only, then the target and the link's directory) each left a way round (security reviews of
	// #915). The target here is safe in every respect, so the link alone is what is refused.
	it('refuses a .env reached through a symbolic link, even to a safe file', () => {
		const target = join(directory, 'real.env');
		writeFileSync(target, 'planted\n');
		chmodSync(target, 0o600);
		symlinkSync(target, join(directory, '.env'));
		expect(() =>
			assertSecretFilesSafe({ BP_STRICT_SECRET_FILES: 'on' }, { cwd: directory })
		).toThrow(
			`.env (${target}) is reached through a symbolic link, so the file checked might not be the file read. Point the setting at the file itself.`
		);
	});

	// A link in a directory ABOVE the file counts too: the key path names a real file, but one of
	// its directories is a link.
	it('refuses a key file under a linked directory', () => {
		const keys = join(directory, 'keys');
		mkdirSync(keys, { mode: 0o700 });
		const key = join(keys, 'enablebanking.pem');
		writeFileSync(key, 'planted\n');
		chmodSync(key, 0o600);
		symlinkSync(keys, join(directory, 'linked-keys'));
		const env = {
			BP_STRICT_SECRET_FILES: 'on',
			ENABLE_BANKING_PRIVATE_KEY_PATH: join(directory, 'linked-keys', 'enablebanking.pem')
		};
		expect(() => assertSecretFilesSafe(env, { cwd: directory })).toThrow(
			`ENABLE_BANKING_PRIVATE_KEY_PATH (${key}) is reached through a symbolic link`
		);
	});

	// The walk itself, on real directories: the file and its own directory are safe, the directory
	// above them is writable by every account. The pure cases above hand-build the list of
	// directories, so they cannot see a walk that stops early.
	it('refuses a file under a directory higher up that every account can write to', () => {
		const open = join(directory, 'open');
		mkdirSync(open);
		chmodSync(open, 0o777);
		const inner = join(open, 'inner');
		mkdirSync(inner, { mode: 0o700 });
		const key = join(inner, 'enablebanking.pem');
		writeFileSync(key, 'planted\n');
		chmodSync(key, 0o600);
		const env = { BP_STRICT_SECRET_FILES: 'on', ENABLE_BANKING_PRIVATE_KEY_PATH: key };
		expect(() => assertSecretFilesSafe(env, { cwd: directory })).toThrow(
			`ENABLE_BANKING_PRIVATE_KEY_PATH (${key}) is under ${open}, which other accounts can write to (mode 777), so they can replace it.`
		);
	});

	it('refuses a value of the switch it does not know, rather than reading it as off', () => {
		expect(() =>
			assertSecretFilesSafe({ BP_STRICT_SECRET_FILES: 'yes' }, { cwd: directory })
		).toThrow('BP_STRICT_SECRET_FILES must be one of off, on (got "yes").');
	});
});
