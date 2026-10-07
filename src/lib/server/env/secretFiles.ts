import { realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { privateKeyPathCandidates } from '$lib/server/banking/enablebanking/jwt';
import { OperatorFacingError } from '$lib/server/operatorFacingError';
import { readChoiceSetting } from './readSetting';

/**
 * THE STRICT SECRET-FILE CHECK (#901), opt-in through `BP_STRICT_SECRET_FILES=on`.
 *
 * C1 (#906) warns at startup when `.env` can be read or written by group or others, and never
 * refuses: a refusal by default would stop every install made before 1.3, whose installer wrote
 * `.env` world-readable. This is the switch for an operator who wants the refusal, and it checks
 * what C1's warning did not: who OWNS the file, and whether its DIRECTORY lets another account
 * replace it. Modelled on OpenSSH's `StrictModes`, which refuses a key file or directory that is
 * writable by others or owned by anyone but the user or root, and stricter on reading: OpenSSH
 * judges an authorized_keys file, which is not a secret, so read for others is refused here whoever
 * owns the file. A path through a symbolic link is refused rather than followed, and every
 * directory up to `/` is judged, as OpenSSH's `safe_path` walks it.
 *
 * Both halves of the triad, for a file that holds a secret:
 * - confidentiality: another account READING it learns TOTP_ENCRYPTION_KEY, RATE_LIMIT_HASH_SECRET,
 *   BOOTSTRAP_TOKEN, a database password or the bank-signing key;
 * - integrity: another account WRITING or REPLACING it points DATABASE_URL or ORIGIN at its own
 *   host at the next start, or swaps the signing key.
 *
 * The files are the ones the app actually loads: `.env` in the working directory (what `vite dev`
 * and a bare-metal `node build` started from the checkout read), and the bank-signing key at the
 * path `jwt.ts` resolves. Under Docker the container has no `.env` (`.dockerignore`), so only the
 * key file is checked there, and it is read by uid 65532.
 */

/** Read for group and others. Execute grants nothing on a data file (#906's rule). */
const GROUP_OR_OTHER_READ = 0o044;
/** Read for others alone: refused on any secret file, whoever owns it. */
const OTHER_READ = 0o004;
/** Write for group and others: on a file, changing it; on a directory, replacing a file in it. */
const GROUP_OR_OTHER_WRITE = 0o022;
const ROOT_UID = 0;

export type DirectoryFacts = { path: string; mode: number; uid: number };

export type SecretFileFacts = {
	/** The variable or file name the operator knows it by. */
	label: string;
	/** The resolved path. */
	path: string;
	mode: number;
	uid: number;
	/** Whether the path as written passes through a symbolic link anywhere. */
	throughLink: boolean;
	/** Every directory from the one holding the file up to `/`, nearest first. */
	directories: DirectoryFacts[];
};

const octal = (mode: number) => (mode & 0o7777).toString(8).padStart(3, '0');
const trusted = (uid: number, processUid: number) => uid === processUid || uid === ROOT_UID;

/** Every problem with every file, in words an operator acts on. A pure function, for its spec. */
export function secretFileProblems(files: SecretFileFacts[], processUid: number): string[] {
	return files.flatMap((file) => {
		const where = `${file.label} (${file.path})`;
		const problems: string[] = [];
		// Write for group or others is refused whoever owns the file. Read for others is refused
		// whoever owns it too: a root-owned 644 secret is readable by every account on the host
		// (contradiction pass on #915). Read for the GROUP is refused only on the app's own file:
		// a systemd credential is root, mode 0400 plus an ACL that `stat` reports as group read 440.
		const ownFile = file.uid === processUid;
		if (ownFile && (file.mode & (GROUP_OR_OTHER_READ | GROUP_OR_OTHER_WRITE)) !== 0) {
			problems.push(
				`${where} can be read or written by other accounts (mode ${octal(file.mode)}).`
			);
		} else if (!ownFile && (file.mode & GROUP_OR_OTHER_WRITE) !== 0) {
			problems.push(`${where} can be changed by other accounts (mode ${octal(file.mode)}).`);
		} else if (!ownFile && (file.mode & OTHER_READ) !== 0) {
			problems.push(`${where} can be read by other accounts (mode ${octal(file.mode)}).`);
		}
		if (!trusted(file.uid, processUid)) {
			problems.push(
				`${where} belongs to account ${file.uid}, not to the account the app runs as (${processUid}).`
			);
		}
		if (file.throughLink) {
			problems.push(
				`${where} is reached through a symbolic link, so the file checked might not be the file read. Point the setting at the file itself.`
			);
		}
		// Every directory up to `/`, as OpenSSH's `safe_path` walks it: whoever can write one of them,
		// or owns it, can rename the branch below it and put another file in its place.
		for (const [index, directory] of file.directories.entries()) {
			const place = index === 0 ? 'is in a directory' : `is under ${directory.path}, which`;
			const owned = index === 0 ? 'that belongs to' : 'belongs to';
			if ((directory.mode & GROUP_OR_OTHER_WRITE) !== 0) {
				problems.push(
					`${where} ${place} other accounts can write to (mode ${octal(directory.mode)}), so they can replace it.`
				);
			}
			if (!trusted(directory.uid, processUid)) {
				problems.push(
					`${where} ${place} ${owned} account ${directory.uid}, so that account can replace it.`
				);
			}
		}
		return problems;
	});
}

/** What inspecting one file found: its facts, or the error code that stopped the inspection. */
type Inspection = { facts: SecretFileFacts } | { label: string; path: string; error: string };

/**
 * Stats the file and every directory above it. `null` only when the file does not exist: no `.env`
 * is the Docker case, and a missing key file is reported by bank sync itself. Any other failure
 * (EACCES on a directory without the search bit, for one) is a finding in strict mode, never « no
 * file ». A path through a symbolic link is reported, and its target still judged.
 */
function inspect(label: string, path: string): Inspection | null {
	try {
		const real = realpathSync(path);
		const file = statSync(real);
		const directories: DirectoryFacts[] = [];
		for (let directory = dirname(real); ; directory = dirname(directory)) {
			const facts = statSync(directory);
			directories.push({ path: directory, mode: facts.mode, uid: facts.uid });
			if (dirname(directory) === directory) break;
		}
		return {
			facts: {
				label,
				path: real,
				mode: file.mode,
				uid: file.uid,
				throughLink: real !== resolve(path),
				directories
			}
		};
	} catch (caught) {
		const code = (caught as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') return null;
		return { label, path, error: code ?? 'unknown error' };
	}
}

/**
 * The secret files this instance loads: `.env` in the working directory, and the first candidate
 * for the key path that is not absent, in the order `jwt.ts` looks for it.
 */
function loadedSecretFiles(env: NodeJS.ProcessEnv, cwd: string): Inspection[] {
	const inspections = [inspect('.env', join(cwd, '.env'))];
	const keyPath = env.ENABLE_BANKING_PRIVATE_KEY_PATH?.trim();
	if (keyPath) {
		const loaded = privateKeyPathCandidates(keyPath)
			.map((candidate) => inspect('ENABLE_BANKING_PRIVATE_KEY_PATH', candidate))
			.find((inspection) => inspection !== null);
		inspections.push(loaded ?? null);
	}
	return inspections.filter((inspection): inspection is Inspection => inspection !== null);
}

/**
 * Boot check, registered in `ENVIRONMENT_CHECKS`. Off (the default): returns at once, and the
 * `.env` warning from #906 stays the only signal. On: refuses to start while any problem exists,
 * listing all of them and the fix. An unknown value of the switch is refused like any other.
 *
 * Skipped on Windows, where these bits do not describe who can read a file (ACLs do), and where
 * there is no uid to compare.
 */
export function assertSecretFilesSafe(
	env: NodeJS.ProcessEnv = process.env,
	{
		platform = process.platform,
		cwd = process.cwd()
	}: { platform?: NodeJS.Platform; cwd?: string } = {}
): void {
	if (readChoiceSetting('BP_STRICT_SECRET_FILES', env) !== 'on') return;
	if (platform === 'win32' || typeof process.getuid !== 'function') return;

	const processUid = process.getuid();
	const inspections = loadedSecretFiles(env, cwd);
	const problems = [
		...inspections.flatMap((inspection) =>
			'error' in inspection
				? [`${inspection.label} (${inspection.path}) could not be inspected (${inspection.error}).`]
				: []
		),
		...secretFileProblems(
			inspections.flatMap((inspection) => ('facts' in inspection ? [inspection.facts] : [])),
			processUid
		)
	];
	if (problems.length === 0) return;
	throw new OperatorFacingError(
		`BP_STRICT_SECRET_FILES is on, and ${problems.length === 1 ? 'a file holding a secret is' : 'files holding secrets are'} exposed:\n` +
			problems.map((problem) => `     - ${problem}`).join('\n') +
			`\n     Fix each file with \`chown ${processUid} <file>\` and \`chmod 600 <file>\`, and keep it in a directory only that account can write to, or set BP_STRICT_SECRET_FILES=off to be warned instead.`
	);
}
