import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomUUID,
	type KeyObject
} from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** The first 12 hex of SHA-256 of the host name: tells hosts apart without writing the name. */
export function hostTag(host: string): string {
	return createHash('sha256').update(host, 'utf8').digest('hex').slice(0, 12);
}

function generateKey(dir: string, keyPath: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const pem = generateKeyPairSync('ml-dsa-44')
		.privateKey.export({ type: 'pkcs8', format: 'pem' })
		.toString();
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

/** The key in `dir`, generated on first use, with its vkey written beside it; or why not. */
export function openSealKey(dir: string): SealKey | SealUnavailable {
	const keyPath = join(dir, 'key.pem');
	let pem: string;
	try {
		pem = readFileSync(keyPath, 'utf8');
	} catch (error) {
		if (codeOf(error) !== 'ENOENT') return unavailable('key_unreadable', error);
		try {
			pem = generateKey(dir, keyPath);
		} catch (generating) {
			return unavailable('dir_unwritable', generating);
		}
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
