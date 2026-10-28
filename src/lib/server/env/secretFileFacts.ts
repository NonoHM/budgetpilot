import { realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * The pure half of the strict secret-file check (#901): the facts about one file and what is wrong
 * with them. Its own module with node-only imports, because the boot (`boot.mjs`, raw Node, no
 * aliases) judges the `<NAME>_FILE` targets with these same rules before it reads them (#826,
 * #1099). `secretFiles.ts` holds the switch and the files the server checks.
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
export type Inspection =
	{ facts: SecretFileFacts } | { label: string; path: string; error: string };

/**
 * Stats the file and every directory above it. `null` only when the file does not exist: no `.env`
 * is the Docker case, and a missing key file is reported by bank sync itself. Any other failure
 * (EACCES on a directory without the search bit, for one) is a finding in strict mode, never « no
 * file ». A path through a symbolic link is reported, and its target still judged.
 */
export function inspect(label: string, path: string): Inspection | null {
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
