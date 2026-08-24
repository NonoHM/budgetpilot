import { describe, expect, it, vi } from 'vitest';
import * as OTPAuth from 'otpauth';

vi.hoisted(() => {
	process.env.TOTP_ENCRYPTION_KEY ??=
		'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'.slice(0, 64);
});

const {
	encryptTotpSecret,
	decryptTotpSecret,
	generateTotpSecretBase32,
	buildTotpUri,
	verifyTotpCode,
	generateRecoveryCodes,
	hashRecoveryCode,
	verifyRecoveryCode
} = await import('./totp');

describe('encryptTotpSecret / decryptTotpSecret', () => {
	it('round-trip : déchiffre exactement le secret chiffré', () => {
		const secret = generateTotpSecretBase32();
		const encrypted = encryptTotpSecret(secret);
		expect(decryptTotpSecret(encrypted)).toBe(secret);
	});

	it('produit un chiffrement différent à chaque appel (IV aléatoire)', () => {
		const secret = generateTotpSecretBase32();
		expect(encryptTotpSecret(secret)).not.toBe(encryptTotpSecret(secret));
	});

	/**
	 * This separates « AES-GCM refuses a ciphertext whose bytes changed » from « AES-GCM accepts
	 * it ». Until #482 a third state answered for both. The tamper rewrote the last two base64url
	 * CHARACTERS, and the trailing characters of a base64url string carry padding bits that no
	 * decoder reads back, so some character edits decode to the identical buffer: decryption then
	 * succeeded because nothing had been tampered with, and the failure read as a cryptographic
	 * one. Measured against this module: 41 non-throws in 50 000 draws, and 64 of the 65 536
	 * trailing byte pairs by exact enumeration — 1 run in 1 024.
	 *
	 * So the mutation goes through the decoded BYTES, the way `crypto.spec.ts`'s `flipFirstByte`
	 * already does, and the setup is asserted rather than assumed. THE ASSERTION COMPARES BYTES
	 * AND NOT STRINGS, which is the part that is easy to get wrong: the tampered string differed
	 * on all 50 000 draws, including every one of the 41 that decoded to the original, so a string
	 * comparison rules nothing out.
	 */
	it('rejects a tampered ciphertext through the TOTP aliases (GCM authTag)', () => {
		const secret = generateTotpSecretBase32();
		const encrypted = encryptTotpSecret(secret);
		const [iv, authTag, ciphertext] = encrypted.split(':');

		const original = Buffer.from(ciphertext, 'base64url');
		expect(original.length).toBeGreaterThan(0);
		const flipped = Buffer.from(original);
		flipped[flipped.length - 1] ^= 0xff;
		const tampered = [iv, authTag, flipped.toString('base64url')].join(':');

		// The tamper tampered. Read back from the value handed to `decryptTotpSecret`, so this
		// covers the re-encoding too and not merely the buffer above.
		expect(Buffer.from(tampered.split(':')[2], 'base64url').equals(original)).toBe(false);

		// The authentication tag rejecting the value, not the format check at the top of
		// `decryptSecret` refusing a malformed part. Both throw, and only the first is evidence
		// about authenticated encryption.
		expect(() => decryptTotpSecret(tampered)).toThrow(/unable to authenticate data/i);
	});
});

describe('generateTotpSecretBase32', () => {
	it('génère un secret base32 valide et non vide', () => {
		const secret = generateTotpSecretBase32();
		expect(secret.length).toBeGreaterThan(0);
		expect(OTPAuth.Secret.fromBase32(secret).base32).toBe(secret);
	});
});

describe('buildTotpUri', () => {
	it("inclut le label et l'issuer BudgetPilot", () => {
		const secret = generateTotpSecretBase32();
		const uri = buildTotpUri('user@example.com', secret);
		expect(uri).toContain('otpauth://totp/');
		expect(uri).toContain('BudgetPilot');
		expect(uri).toContain(encodeURIComponent('user@example.com'));
	});
});

describe('verifyTotpCode', () => {
	it('accepte un code TOTP valide généré pour le même secret', () => {
		const secret = generateTotpSecretBase32();
		const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
		const code = totp.generate();
		expect(verifyTotpCode(secret, code)).toBe(true);
	});

	it('rejette un code invalide', () => {
		const secret = generateTotpSecretBase32();
		expect(verifyTotpCode(secret, '000000')).toBe(false);
	});

	it('rejette un code valide pour un autre secret', () => {
		const secretA = generateTotpSecretBase32();
		const secretB = generateTotpSecretBase32();
		const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretB) });
		const code = totp.generate();
		expect(verifyTotpCode(secretA, code)).toBe(false);
	});
});

describe('generateRecoveryCodes', () => {
	it('génère 10 codes uniques au format XXXXX-XXXXX par défaut', () => {
		const codes = generateRecoveryCodes();
		expect(codes).toHaveLength(10);
		expect(new Set(codes).size).toBe(10);
		for (const code of codes) {
			expect(code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
		}
	});

	it('respecte le count demandé', () => {
		expect(generateRecoveryCodes(3)).toHaveLength(3);
	});
});

describe('hashRecoveryCode / verifyRecoveryCode', () => {
	it('valide un code correct et rejette un code incorrect', async () => {
		const [code] = generateRecoveryCodes(1);
		const hash = await hashRecoveryCode(code);
		expect(await verifyRecoveryCode(code, hash)).toBe(true);
		expect(await verifyRecoveryCode('00000-00000', hash)).toBe(false);
	});
});
