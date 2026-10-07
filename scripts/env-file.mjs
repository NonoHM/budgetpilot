// Writes the .env that `npm run setup` generates. Node built-ins only, like setup.mjs, which runs on
// a fresh clone before `npm install`.
import { randomBytes } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Writes `content` to `envPath` readable and writable by its owner only (#826): the file holds
 * TOTP_ENCRYPTION_KEY, RATE_LIMIT_HASH_SECRET, BOOTSTRAP_TOKEN and sometimes a database password,
 * and a mode taken from the umask (644 on a usual machine) lets every local account read them.
 *
 * Through a temporary file in the same directory, renamed over `.env`, rather than writeFile with a
 * mode: writeFile's `mode` applies only when it CREATES the file, so an existing 644 `.env`, which
 * every install made before this fix has, would keep 644 when setup overwrites it. The rename
 * replaces the inode, so the new mode holds, and an interrupted run never leaves a half-written
 * `.env`. `wx` refuses a temporary path that already exists, symlink included, so the write cannot
 * be redirected; and the temporary file is removed on failure only if this call created it.
 *
 * @param {string} envPath
 * @param {string} content
 * @returns {Promise<void>}
 */
export async function writeEnvFile(envPath, content) {
	const tempPath = path.join(
		path.dirname(envPath),
		`.env.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
	);
	let created = false;
	try {
		const handle = await open(tempPath, 'wx', 0o600);
		created = true;
		try {
			await handle.writeFile(content, 'utf8');
		} finally {
			await handle.close();
		}
		await rename(tempPath, envPath);
	} catch (error) {
		if (created) await rm(tempPath, { force: true });
		throw error;
	}
}
