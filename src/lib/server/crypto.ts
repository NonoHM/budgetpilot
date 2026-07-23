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
const rawEncryptionKey = env.TOTP_ENCRYPTION_KEY;
if (!rawEncryptionKey) {
	throw new Error('TOTP_ENCRYPTION_KEY is required (set it in your environment)');
}
const ENCRYPTION_KEY = Buffer.from(rawEncryptionKey, 'hex');
if (ENCRYPTION_KEY.length !== 32) {
	throw new Error('TOTP_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex characters)');
}

export function encryptSecret(plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
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

	const decipher = createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
	decipher.setAuthTag(authTag);
	const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	return plaintext.toString('utf8');
}
