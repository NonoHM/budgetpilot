import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
	process.env.TOTP_ENCRYPTION_KEY ??=
		'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'.slice(0, 64);
});

const { encryptSecret, decryptSecret } = await import('./crypto');
const { encryptTotpSecret, decryptTotpSecret } = await import('./auth/totp');

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

	it('rejette un texte chiffré altéré (authTag GCM)', () => {
		const encrypted = encryptSecret('secret original');
		const [iv, authTag, ciphertext] = encrypted.split(':');
		const tampered = [iv, authTag, ciphertext.slice(0, -2) + 'aa'].join(':');
		expect(() => decryptSecret(tampered)).toThrow();
	});

	it('rejette un authTag altéré même si le ciphertext est intact', () => {
		const encrypted = encryptSecret('secret original');
		const [iv, authTag, ciphertext] = encrypted.split(':');
		// Flip the last byte rather than hardcoding one: a fixed 'aa' silently
		// leaves the tag untouched the ~1 run in 256 where it already ends in aa,
		// and the test then passes a valid tag to decryptSecret and fails.
		const flippedLastByte = ((parseInt(authTag.slice(-2), 16) ^ 0xff) & 0xff)
			.toString(16)
			.padStart(2, '0');
		const tampered = [iv, authTag.slice(0, -2) + flippedLastByte, ciphertext].join(':');
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
