import { join } from 'node:path';
import { privateKeyPathCandidates } from '$lib/server/banking/enablebanking/jwt';
import { OperatorFacingError } from '$lib/server/operatorFacingError';
import { readChoiceSetting } from './readSetting';
import { inspect, secretFileProblems, type Inspection } from './secretFileFacts';

export { secretFileProblems, type DirectoryFacts, type SecretFileFacts } from './secretFileFacts';

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
