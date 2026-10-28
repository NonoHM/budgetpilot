import {
	createHmac,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomUUID,
	type KeyObject
} from 'node:crypto';
import {
	linkSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import type { SealUnavailableReason } from '../events.ts';
import { vkeyOf } from './note.ts';

/**
 * The files of the log seal (#875), all in `BP_LOG_SEAL_DIR`:
 *
 * - `key.pem`, the ML-DSA-44 private key, PKCS#8 PEM, mode 0600. Generated on the first start with
 *   sealing on, written to a temporary name with `wx` then LINKED into place, so two containers
 *   starting together on one volume never overwrite each other's key: the loser reads the winner's.
 * - `verification.vkey`, the C2SP vkey of that key, rewritten at every start (temporary + rename)
 *   so it always matches the key in use. Public: the operator copies it off the machine.
 * - `last-checkpoint.<host tag>`, the newest checkpoint this host wrote, written AFTER the checkpoint
 *   line, so a crash between the two names an earlier checkpoint the log still holds. One per host
 *   (design note A10), so two containers on one volume each link their own previous start.
 * - `last-checkpoint.volume`, the newest checkpoint ANY host on this volume wrote, written the same
 *   way after the host's file (design note A14). A recreated container is a new host, so without it
 *   a start between two recreations could be removed from a copy unseen. One file overwritten by
 *   every host is « the newest `last-checkpoint.*` by modification time » without reading clocks
 *   whose granularity is coarser than two starts in a row.
 *
 * Imported by `boot.mjs` as TypeScript source: erasable syntax only, relative imports only.
 */

/** The key name in every signature line. Not the origin, which changes per segment (#875). */
export const SEAL_KEY_NAME = 'budgetpilot/log';

/** A filesystem error code, admitted only in the shape of one. */
const FS_ERROR_CODE = /^[A-Z0-9_]{1,40}$/;

export interface SealKey {
	privateKey: KeyObject;
	keyId: string;
}

export interface SealUnavailable {
	reason: SealUnavailableReason;
	code?: string;
}

export interface LinkedCheckpoint {
	origin: string;
	size: number;
	root: string;
}

const codeOf = (error: unknown): string | undefined => {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string' && FS_ERROR_CODE.test(code) ? code : undefined;
};

const unavailable = (reason: SealUnavailableReason, error?: unknown): SealUnavailable => {
	const code = codeOf(error);
	return code === undefined ? { reason } : { reason, code };
};

/** Where every host on the volume records its newest checkpoint (A14). */
export const VOLUME_LINK_FILE = 'last-checkpoint.volume';

/**
 * Tells hosts apart without writing the host name (design note A15): HMAC-SHA-256 keyed by the seal
 * key's PKCS#8 DER, first 12 hex. A plain hash of the name could be reversed by trying names.
 */
export function hostTag(host: string, privateKey: KeyObject): string {
	return createHmac('sha256', privateKey.export({ type: 'pkcs8', format: 'der' }))
		.update(host, 'utf8')
		.digest('hex')
		.slice(0, 12);
}

function placeKey(dir: string, keyPath: string, pem: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temporary = join(dir, `key.pem.${randomUUID()}.tmp`);
	writeFileSync(temporary, pem, { flag: 'wx', mode: 0o600 });
	try {
		linkSync(temporary, keyPath);
		return pem;
	} catch (error) {
		if (codeOf(error) !== 'EEXIST') throw error;
		return readFileSync(keyPath, 'utf8');
	} finally {
		unlinkSync(temporary);
	}
}

/**
 * PostgreSQL's rule for its TLS key (`check_ssl_key_file_permissions`): owned by this user, 0600 or
 * less; owned by root, 0640 or less. Not applicable where the platform has no uid.
 */
function exposed(keyPath: string): boolean {
	const uid = process.getuid?.();
	if (uid === undefined) return false;
	const { uid: owner, mode } = statSync(keyPath);
	if (owner === uid) return (mode & 0o077) !== 0;
	return owner === 0 && (mode & 0o037) !== 0;
}

/** The key in `dir`, generated on first use, with its vkey written beside it; or why not. */
export function openSealKey(dir: string): SealKey | SealUnavailable {
	const keyPath = join(dir, 'key.pem');
	let pem: string;
	try {
		pem = readFileSync(keyPath, 'utf8');
	} catch (error) {
		if (codeOf(error) !== 'ENOENT') return unavailable('key_unreadable', error);
		let generated: string;
		try {
			generated = generateKeyPairSync('ml-dsa-44')
				.privateKey.export({ type: 'pkcs8', format: 'pem' })
				.toString();
		} catch {
			return unavailable('keygen_failed');
		}
		try {
			pem = placeKey(dir, keyPath, generated);
		} catch (placing) {
			return unavailable('dir_unwritable', placing);
		}
	}
	try {
		if (exposed(keyPath)) return unavailable('key_exposed');
	} catch (error) {
		return unavailable('key_unreadable', error);
	}
	let privateKey: KeyObject;
	try {
		privateKey = createPrivateKey(pem);
	} catch {
		return unavailable('key_invalid');
	}
	if (privateKey.asymmetricKeyType !== 'ml-dsa-44') return unavailable('key_invalid');
	const vkey = vkeyOf(SEAL_KEY_NAME, createPublicKey(privateKey));
	try {
		const temporary = join(dir, `verification.vkey.${randomUUID()}.tmp`);
		writeFileSync(temporary, `${vkey}\n`, { flag: 'wx', mode: 0o644 });
		renameSync(temporary, join(dir, 'verification.vkey'));
	} catch (error) {
		return unavailable('dir_unwritable', error);
	}
	return { privateKey, keyId: vkey.split('+')[1] };
}

/** The checkpoint a state file names, or undefined when it is absent or does not read as one. */
export function readLinkedCheckpoint(path: string): LinkedCheckpoint | undefined {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
	const [origin, size, root] = text.split('\n');
	if (
		!origin ||
		!/^(0|[1-9][0-9]*)$/.test(size ?? '') ||
		!/^[A-Za-z0-9+/]{43}=$/.test(root ?? '')
	) {
		return undefined;
	}
	return { origin, size: Number(size), root };
}

/**
 * Records the checkpoint just written. A failure is not reported: the checkpoint line is already
 * out, and the next start then links an earlier checkpoint the log still holds.
 */
export function writeLinkedCheckpoint(path: string, checkpoint: LinkedCheckpoint): void {
	try {
		const temporary = `${path}.${randomUUID()}.tmp`;
		writeFileSync(temporary, `${checkpoint.origin}\n${checkpoint.size}\n${checkpoint.root}\n`, {
			flag: 'wx',
			mode: 0o644
		});
		renameSync(temporary, path);
	} catch {
		// shortcut: a read-only volume after start leaves the link one checkpoint behind, silently;
		// a WARN here would repeat at every interval.
	}
}
