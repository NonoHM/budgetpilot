import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

/**
 * App-wide symmetric encryption for secrets at rest (TOTP secret, bank connection
 * credentials, ...). AES-256-GCM with a random 12-byte IV per encryption, never reused.
 *
 * Storage format: "iv:authTag:ciphertext", each part base64url-encoded, all in a single
 * text field storable in DB.
 *
 * Key management: single key from TOTP_ENCRYPTION_KEY (historical name kept so existing
 * deployments don't break — it is now the app-wide data-encryption key, not TOTP-only).
 * No automatic key rotation in V1. Stored rows carry no key-version tag: a future
 * rotation must be a one-shot re-encryption migration (decrypt every encrypted column
 * with the old key, re-encrypt with the new one, swap the env var) — the per-row format
 * above stays valid unchanged through such a migration.
 */
// Read lazily, for the reason recorded in server/env/assertConfigured.ts: a module-level throw
// cannot be collected with the other checks, and when two modules both throw at load the order an
// operator meets them in is decided by the production chunk graph rather than by the import order
// in hooks.server.ts. The lazy read keeps a direct import loud — encryptSecret/decryptSecret throw
// with the same message on first use if boot never ran.
let cachedKey: Buffer | undefined;

function encryptionKey(): Buffer {
	if (cachedKey === undefined) {
		assertEncryptionKeyConfigured();
		cachedKey = Buffer.from(env.TOTP_ENCRYPTION_KEY!.trim(), 'hex');
	}
	return cachedKey;
}

/**
 * One message, not two.
 *
 * It used to be a presence check that did not state the format, followed by a format check that
 * only ran on the next boot. That is half of the four-boot install a first user actually walked:
 * a base64 value — which is what `openssl rand -base64 32` prints, and what the neighbouring
 * BOOTSTRAP_TOKEN asks for — passed the first check and failed the second. Naming the format in
 * the message that fires first is the whole fix.
 *
 * Exported for the boot collector and for its own spec.
 */
export function assertEncryptionKeyConfigured(source: NodeJS.ProcessEnv = env): void {
	const raw = source.TOTP_ENCRYPTION_KEY?.trim();
	if (!raw) {
		throw new Error(
			'TOTP_ENCRYPTION_KEY is required: it encrypts the two-factor secrets and the bank ' +
				'credentials held in the database, so nothing that reads them can start without it. Set ' +
				'it to 64 hex characters (generate one with `openssl rand -hex 32`, NOT -base64). Keep ' +
				'the value: rotating it makes every already-enrolled second factor undecryptable.'
		);
	}
	if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
		throw new Error(
			`TOTP_ENCRYPTION_KEY must be exactly 64 hex characters, the 32 bytes AES-256 takes ` +
				`(received ${raw.length}). A base64 value of the right byte length is 44 characters and ` +
				'is refused here. Generate one with `openssl rand -hex 32`.'
		);
	}
}

export function encryptSecret(plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return [iv, authTag, ciphertext].map((buf) => buf.toString('base64url')).join(':');
}

export function decryptSecret(encrypted: string): string {
	const parts = encrypted.split(':');
	const [ivPart, authTagPart, ciphertextPart] = parts;
	// ciphertextPart may legitimately be empty: AES-GCM on an empty plaintext yields an
	// empty ciphertext (the authTag still authenticates it), so only iv/authTag must be
	// non-empty for the format to be valid.
	if (parts.length !== 3 || !ivPart || !authTagPart || ciphertextPart === undefined) {
		throw new Error('Invalid encrypted secret format');
	}
	const iv = Buffer.from(ivPart, 'base64url');
	const authTag = Buffer.from(authTagPart, 'base64url');
	const ciphertext = Buffer.from(ciphertextPart, 'base64url');

	const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
	decipher.setAuthTag(authTag);
	const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	return plaintext.toString('utf8');
}
