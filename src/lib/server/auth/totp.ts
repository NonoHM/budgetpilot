import { randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { hashPassword, verifyPassword } from '$lib/server/auth';
import { decryptSecret, encryptSecret } from '$lib/server/crypto';

const ISSUER = 'BudgetPilot';
const TOTP_WINDOW = 1;
const RECOVERY_CODE_COUNT = 10;

// Encryption itself lives in $lib/server/crypto (shared AES-256-GCM module,
// same key and storage format as before the extraction). These aliases keep the
// TOTP call sites and their intent-revealing names unchanged.
export const encryptTotpSecret = encryptSecret;
export const decryptTotpSecret = decryptSecret;

export function generateTotpSecretBase32(): string {
	return new OTPAuth.Secret({ size: 20 }).base32;
}

export function buildTotpUri(email: string, secretBase32: string): string {
	const totp = new OTPAuth.TOTP({
		issuer: ISSUER,
		label: email,
		secret: OTPAuth.Secret.fromBase32(secretBase32)
	});
	return totp.toString();
}

export async function generateTotpQrCodeDataUrl(uri: string): Promise<string> {
	return QRCode.toDataURL(uri);
}

// window: 1 tolerates a +/- 1 period (30s) clock skew on the user's device.
export function verifyTotpCode(secretBase32: string, code: string): boolean {
	const totp = new OTPAuth.TOTP({
		issuer: ISSUER,
		secret: OTPAuth.Secret.fromBase32(secretBase32)
	});
	const delta = totp.validate({ token: code, window: TOTP_WINDOW });
	return delta !== null;
}

// Human-readable/copyable format: 10 uppercase hex chars in 2 groups of 5, separated by a dash.
function generateRecoveryCode(): string {
	const raw = randomBytes(5).toString('hex').toUpperCase();
	return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
	return Array.from({ length: count }, () => generateRecoveryCode());
}

// Backup codes: hashed like passwords (bcrypt) since they're single-use, never
// reused to decrypt anything — unlike the TOTP secret.
export async function hashRecoveryCode(code: string): Promise<string> {
	return hashPassword(code);
}

export async function verifyRecoveryCode(code: string, codeHash: string): Promise<boolean> {
	return verifyPassword(code, codeHash);
}
