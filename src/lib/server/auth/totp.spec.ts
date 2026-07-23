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

	it('rejette un texte chiffré altéré (authTag GCM)', () => {
		const secret = generateTotpSecretBase32();
		const encrypted = encryptTotpSecret(secret);
		const [iv, authTag, ciphertext] = encrypted.split(':');
		const tampered = [iv, authTag, ciphertext.slice(0, -2) + 'aa'].join(':');
		expect(() => decryptTotpSecret(tampered)).toThrow();
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
