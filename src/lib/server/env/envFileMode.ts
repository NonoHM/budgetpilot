import { statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every permission bit of group and others: read, write and execute (#826). Not the read bits
 * alone. Read is the confidentiality half, since `.env` holds TOTP_ENCRYPTION_KEY,
 * RATE_LIMIT_HASH_SECRET, BOOTSTRAP_TOKEN and sometimes a database password. Write is the integrity
 * half: another local account that can write `.env` can point DATABASE_URL at its own database or
 * ORIGIN at its own host, and the app reads that at its next start.
 */
const GROUP_OR_OTHER = 0o077;

/**
 * The mode to report, in octal, when another account can use `.env`; null when there is nothing to
 * report. A pure function of the mode and the platform, for its spec.
 *
 * - `null` mode: no `.env` in the working directory, so nothing to decide. Under Docker, Compose
 *   reads `.env` on the host and the container never has one.
 * - `win32`: these bits do not describe who can read a file there; access is decided by ACLs.
 */
export function exposedEnvFileMode(mode: number | null, platform: NodeJS.Platform): string | null {
	if (mode === null || platform === 'win32') return null;
	if ((mode & GROUP_OR_OTHER) === 0) return null;
	return (mode & 0o777).toString(8).padStart(3, '0');
}

/**
 * The mode of the `.env` in `directory`, or null when it cannot be read. The check reports and never
 * gates, so a stat that fails is treated like an absent file rather than stopping the server.
 */
export function readEnvFileMode(directory: string): number | null {
	try {
		return statSync(join(directory, '.env')).mode;
	} catch {
		return null;
	}
}
