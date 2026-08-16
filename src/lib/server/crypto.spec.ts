import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
	process.env.TOTP_ENCRYPTION_KEY ??=
		'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'.slice(0, 64);
});

const { encryptSecret, decryptSecret, assertEncryptionKeyConfigured } = await import('./crypto');
const { encryptTotpSecret, decryptTotpSecret } = await import('./auth/totp');

/**
 * Flips every bit of the first byte of a base64url-encoded part, and re-encodes it.
 *
 * Tampering tests must go through the decoded bytes. Editing the base64url characters
 * directly is not equivalent: the trailing character of a base64url string carries
 * padding bits that no decoder reads back, so some character edits decode to the exact
 * same buffer and hand `decryptSecret` a perfectly valid value. A previous version of
 * these tests also ran hex arithmetic (`parseInt(part.slice(-2), 16)`) over characters
 * that are base64url, not hex. Both made the tests fail at random in CI.
 *
 * Flipping a real byte always changes the value, so these tests are deterministic.
 */
function flipFirstByte(base64urlPart: string): string {
	const bytes = Buffer.from(base64urlPart, 'base64url');
	expect(bytes.length).toBeGreaterThan(0);
	bytes[0] ^= 0xff;
	return bytes.toString('base64url');
}

describe('encryptSecret / decryptSecret', () => {
	it('round-trip : déchiffre exactement le texte chiffré', () => {
		const plaintext = 'un secret bancaire très sensible';
		const encrypted = encryptSecret(plaintext);
		expect(decryptSecret(encrypted)).toBe(plaintext);
	});

	it('produit un chiffrement différent à chaque appel (IV aléatoire)', () => {
		const plaintext = 'même texte';
		expect(encryptSecret(plaintext)).not.toBe(encryptSecret(plaintext));
	});

	it('rejects a tampered ciphertext (GCM authTag)', () => {
		const encrypted = encryptSecret('secret original');
		const [iv, authTag, ciphertext] = encrypted.split(':');
		const tampered = [iv, authTag, flipFirstByte(ciphertext)].join(':');
		expect(() => decryptSecret(tampered)).toThrow();
	});

	it('rejects a tampered authTag even when the ciphertext is intact', () => {
		const encrypted = encryptSecret('secret original');
		const [iv, authTag, ciphertext] = encrypted.split(':');
		const tampered = [iv, flipFirstByte(authTag), ciphertext].join(':');
		expect(() => decryptSecret(tampered)).toThrow();
	});

	it('rejette un format malformé sans IV', () => {
		expect(() => decryptSecret(':authtag:ciphertext')).toThrow();
	});

	it('rejette un format malformé avec une seule partie (pas de séparateur)', () => {
		expect(() => decryptSecret('pasdusecretchiffre')).toThrow('Invalid encrypted secret format');
	});

	it('rejette un format malformé à deux parties seulement (authTag manquant)', () => {
		expect(() => decryptSecret('iv-only:ciphertext-only')).toThrow(
			'Invalid encrypted secret format'
		);
	});

	it('round-trip correct pour un texte clair non-ASCII (accents, emoji)', () => {
		const plaintext = 'Crédit Agricole – café ☕ 42€';
		const encrypted = encryptSecret(plaintext);
		expect(decryptSecret(encrypted)).toBe(plaintext);
	});

	it('round-trip correct pour un texte clair vide (ciphertext GCM vide mais authentifié)', () => {
		const encrypted = encryptSecret('');
		expect(decryptSecret(encrypted)).toBe('');
	});

	it('rejette un format à quatre parties (séparateur en trop)', () => {
		const encrypted = encryptSecret('secret');
		expect(() => decryptSecret(`${encrypted}:extra`)).toThrow('Invalid encrypted secret format');
	});
});

describe('compatibilité entre crypto.ts et les alias historiques de totp.ts', () => {
	it('decryptTotpSecret déchiffre un texte chiffré par encryptSecret', () => {
		const plaintext = 'JBSWY3DPEHPK3PXP';
		const encrypted = encryptSecret(plaintext);
		expect(decryptTotpSecret(encrypted)).toBe(plaintext);
	});

	it('decryptSecret déchiffre un texte chiffré par encryptTotpSecret (anciennes lignes compatibles)', () => {
		const plaintext = 'JBSWY3DPEHPK3PXP';
		const encrypted = encryptTotpSecret(plaintext);
		expect(decryptSecret(encrypted)).toBe(plaintext);
	});
});

describe('assertEncryptionKeyConfigured', () => {
	// The two-boot sequence a first user walked: the presence check did not state the format, so a
	// base64 value passed it and failed on the next boot. One message now carries both.
	it('names the format in the missing-value message, not only in the malformed one', () => {
		expect(() => assertEncryptionKeyConfigured({})).toThrow(/64 hex characters/);
		expect(() => assertEncryptionKeyConfigured({})).toThrow(/openssl rand -hex 32/);
	});

	it('refuses a base64 value of the right byte length', () => {
		// 32 random bytes in base64 is 44 characters — the shape `openssl rand -base64 32` prints,
		// which is what the neighbouring BOOTSTRAP_TOKEN asks for.
		const base64Key = Buffer.alloc(32, 7).toString('base64');
		expect(base64Key).toHaveLength(44);
		expect(() => assertEncryptionKeyConfigured({ TOTP_ENCRYPTION_KEY: base64Key })).toThrow(
			/64 hex characters/
		);
	});

	it('accepts exactly 64 hex characters', () => {
		expect(() =>
			assertEncryptionKeyConfigured({ TOTP_ENCRYPTION_KEY: 'c1'.repeat(32) })
		).not.toThrow();
	});
});
