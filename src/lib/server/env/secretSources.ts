import { readFileSync } from 'node:fs';
import { OperatorFacingError } from '../operatorFacingError.ts';
import { inspect, secretFileProblems } from './secretFileFacts.ts';

/**
 * WHERE A SECRET COMES FROM (#826 part 2, #1099): a plain variable, or `<NAME>_FILE` naming a file
 * that holds it, which is what Docker and Compose `secrets:`, systemd credentials and a vault agent
 * writing a file deliver. Never both, and nothing fetched over the network.
 *
 * Run once, before anything reads a secret: `boot.mjs` before `prisma migrate deploy` and the server
 * import (SvelteKit's `Server.init` copies the environment into `$env/dynamic/private` before it
 * imports the hooks, so a later resolver would be too late), `prisma.config.ts` for a CLI run that
 * replaces the image's command, and the operator scripts shipped in the image. Imported by them as
 * TypeScript source, so node-only imports with their extensions.
 *
 * The value is written into this process's environment, because about ten readers take it from
 * there; what the file form buys is that the value is absent from the container's configuration
 * (`docker inspect`, the Compose file, the host's `.env`). The `_FILE` variable is then removed, as
 * the docker-library `file_env` that the convention comes from unsets it, so a second run is a no-op
 * and the server can tell a `_FILE` nothing resolved (`assertSecretSourcesConfigured`).
 *
 * A refusal names variables and error codes, never a value, never the configured path (an operator
 * who writes the secret where the path belongs has written it there), never the database URL.
 */

/**
 * The secrets with a file form, each with its `_FILE` name spelled out so that a search for the
 * name finds its reader (`settingsDrift.spec.ts`). The bank key's `ENABLE_BANKING_PRIVATE_KEY_PATH`
 * already is one.
 */
export const FILE_FORM_SECRETS = [
	['TOTP_ENCRYPTION_KEY', 'TOTP_ENCRYPTION_KEY_FILE'],
	['RATE_LIMIT_HASH_SECRET', 'RATE_LIMIT_HASH_SECRET_FILE'],
	['BOOTSTRAP_TOKEN', 'BOOTSTRAP_TOKEN_FILE'],
	['DATABASE_PASSWORD', 'DATABASE_PASSWORD_FILE']
] as const;

/** A filesystem error code, admitted only in the shape of one. */
const FS_ERROR_CODE = /^[A-Z0-9_]{1,40}$/;

const isSet = (value: string | undefined) => Boolean(value?.trim());

const errorCode = (caught: unknown) => {
	const code = (caught as NodeJS.ErrnoException).code;
	return typeof code === 'string' && FS_ERROR_CODE.test(code) ? code : 'an unknown error';
};

/** The URL with the password in its userinfo, percent-encoded, or why it cannot take one. */
function withPassword(databaseUrl: string | undefined, password: string): { url: string } | { problem: string } {
	let url: URL;
	try {
		url = new URL(databaseUrl ?? '');
	} catch {
		// The TypeError's `input` is the whole URL, which can hold a password: never quoted.
		url = new URL('invalid:');
	}
	// A pg socket URL (`postgresql://u@/db?host=/run/postgresql`) has no host here either; refused
	// with the rest rather than parsed a second way.
	if (!url.hostname) {
		return {
			problem:
				'DATABASE_PASSWORD_FILE is set, but DATABASE_URL does not name a PostgreSQL or MySQL server to use it with.'
		};
	}
	// Both drivers let `?password=` override the userinfo password, so it counts as one (pass 1, F5).
	if (url.password || url.searchParams.has('password')) {
		return {
			problem:
				'DATABASE_PASSWORD_FILE is set, and DATABASE_URL already carries a password. Remove the password from DATABASE_URL.'
		};
	}
	if (!url.username) {
		return { problem: 'DATABASE_PASSWORD_FILE is set, but DATABASE_URL names no user for the password.' };
	}
	// The setter leaves `+` and `%` as they are (WHATWG userinfo percent-encode set), and a driver can
	// read `+` as a space: encode the whole password first.
	url.password = encodeURIComponent(password);
	return { url: url.href };
}

/**
 * Resolves every `<NAME>_FILE` in `env`, in place, or throws one `OperatorFacingError` listing every
 * problem and changes nothing. Under `BP_STRICT_SECRET_FILES=on` each file is judged by #901's rules
 * before it is read. Any value of the switch other than `on` reads as off here; the server's
 * `readChoiceSetting` refuses a value that is not one of its choices before anything is served.
 */
export function applySecretSources(env: NodeJS.ProcessEnv = process.env): void {
	const strict =
		env.BP_STRICT_SECRET_FILES?.trim() === 'on' &&
		process.platform !== 'win32' &&
		typeof process.getuid === 'function';
	const problems: string[] = [];
	const values = new Map<string, string>();

	for (const [name, fileName] of FILE_FORM_SECRETS) {
		const path = env[fileName];
		if (!isSet(path)) continue;
		if (isSet(env[name])) {
			problems.push(
				`${name} and ${fileName} are both set. Set one of them, so that the value the app runs with is the one you edit.`
			);
			continue;
		}
		if (strict) {
			const inspection = inspect(fileName, path!);
			if (inspection && 'error' in inspection) {
				problems.push(`${fileName} names a file that could not be inspected (${inspection.error}).`);
				continue;
			}
			if (inspection) {
				const found = secretFileProblems([inspection.facts], process.getuid!());
				if (found.length > 0) {
					problems.push(...found);
					continue;
				}
			}
		}
		let value: string;
		try {
			value = readFileSync(path!, 'utf8').replace(/[\r\n]+$/, '');
		} catch (caught) {
			problems.push(`${fileName} names a file that could not be read (${errorCode(caught)}).`);
			continue;
		}
		// Empty after the strip is unset, as the empty plain variable is.
		if (value !== '') values.set(name, value);
	}

	let databaseUrl: string | undefined;
	const password = values.get('DATABASE_PASSWORD');
	if (password !== undefined) {
		values.delete('DATABASE_PASSWORD');
		const resolved = withPassword(env.DATABASE_URL, password);
		if ('problem' in resolved) problems.push(resolved.problem);
		else databaseUrl = resolved.url;
	}

	if (problems.length > 0) {
		throw new OperatorFacingError(
			(problems.length === 1
				? 'A secret could not be read from its file:\n'
				: 'Secrets could not be read from their files:\n') +
				problems.map((problem) => `     - ${problem}`).join('\n')
		);
	}
	for (const [name, value] of values) env[name] = value;
	if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
	for (const [, fileName] of FILE_FORM_SECRETS) delete env[fileName];
}

/**
 * Boot check, registered in `ENVIRONMENT_CHECKS`: a `<NAME>_FILE` still set when the server starts
 * was read by nothing, because the resolver removes every one it reads. That is a start other than
 * the image's (`node build`, `vite dev`; owner's ruling 2026-10-28: the file form is the image's),
 * and without this the secret would read as missing, with a message that never names the file.
 */
export function assertSecretSourcesConfigured(env: NodeJS.ProcessEnv = process.env): void {
	const unread = FILE_FORM_SECRETS.filter(([, fileName]) => isSet(env[fileName]));
	if (unread.length === 0) return;
	throw new OperatorFacingError(
		unread
			.map(
				([name, fileName]) =>
					`${fileName} is set, but nothing read it: the file form is read when the app starts from its image. Started another way, set ${name} itself.`
			)
			.join('\n')
	);
}
