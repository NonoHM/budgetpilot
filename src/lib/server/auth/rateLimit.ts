import { createHmac } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';

const WINDOW_MS = 15 * 60 * 1000;
// REAUTH is deliberately shorter than the 15-minute LOGIN/etc window. Every REAUTH action sits
// BEHIND a valid session (deleteAccount, changePassword, disableTotp, confirmTotpSetup), so the
// limiter is secondary containment, not the front-line gate, and its real job is only to keep a
// session-holder from grinding the password/TOTP unboundedly. Security here is dominated by argon2
// (slow) and the TOTP mechanics (~90s validity in a 10^6 space), so 5 tries per 5-minute sliding
// window loses no protection versus 15 minutes: it only shortens the honest owner's self-inflicted
// lockout. The window is what bounds the "cannot leave the account stuck" guarantee: because only
// FAILED attempts are recorded and the window slides, a tripped counter self-clears in ~5 minutes
// with no admin, so the escape hatch (deleteAccount) always reopens on its own.
const REAUTH_WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

// The secret is read lazily rather than at module load. It used to throw from this module's
// top-level body, which is why hooks.server.ts imported it for its side effect alone — and why
// the order in which an operator meets the three secret failures was a property of the production
// chunk graph rather than of the source (source order there was rateLimit then crypto; the
// published image threw TOTP_ENCRYPTION_KEY first). assertRateLimitSecretConfigured is called from
// the boot collector instead, which reports every problem at once. The lazy read keeps the failure
// loud for a direct import that never ran boot: the first hashed key throws with the same message
// rather than silently keying on undefined.
let cachedHashSecret: string | undefined;

function hashSecret(): string {
	if (cachedHashSecret === undefined) {
		assertRateLimitSecretConfigured();
		cachedHashSecret = env.RATE_LIMIT_HASH_SECRET!.trim();
	}
	return cachedHashSecret;
}

// 64 hex characters is not a style preference: this value is used directly as an HMAC-SHA256 key
// in hashRateLimitKey below, so its length IS the key strength (ASVS 5.0 V11.2.3, key size, and
// V11.5.1, entropy). docs/getting-started.md:388 has promised the format since the variable
// existed, `openssl rand -hex 32` at :66 produces it, and nothing enforced it — so
// `RATE_LIMIT_HASH_SECRET=changeme` was accepted and produced a 64-bit key, a security control the
// documentation claimed and the code did not have. Exported for the boot collector and its spec.
export function assertRateLimitSecretConfigured(source: NodeJS.ProcessEnv = env): void {
	const raw = source.RATE_LIMIT_HASH_SECRET?.trim();
	if (!raw) {
		throw new Error(
			'RATE_LIMIT_HASH_SECRET is required: it is the HMAC key that hashes the emails and IP ' +
				'addresses recorded for login rate limiting, so without it the limiter has nothing to ' +
				'key on. Set it to 64 hex characters (generate one with `openssl rand -hex 32`).'
		);
	}
	if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
		throw new Error(
			`RATE_LIMIT_HASH_SECRET must be exactly 64 hex characters (received ${raw.length}). It is ` +
				'used directly as an HMAC-SHA256 key, so a shorter value is a weaker key rather than a ' +
				'shorter name. Generate one with `openssl rand -hex 32`.'
		);
	}
}

type AttemptKind = 'LOGIN' | 'REGISTER' | 'INVITE' | 'MFA' | 'BANK_SYNC_START' | 'REAUTH';

function windowMsForKind(kind: AttemptKind): number {
	return kind === 'REAUTH' ? REAUTH_WINDOW_MS : WINDOW_MS;
}

function hashRateLimitKey(value: string): string {
	return createHmac('sha256', hashSecret()).update(value.trim().toLowerCase()).digest('hex');
}

async function isRateLimited(kind: AttemptKind, ip: string, email?: string): Promise<boolean> {
	const ipHash = hashRateLimitKey(ip);
	const windowStart = new Date(Date.now() - windowMsForKind(kind));
	const checks = [];
	if (email !== undefined) {
		const emailHash = hashRateLimitKey(email);
		checks.push(
			prisma.loginAttempt.count({ where: { emailHash, kind, createdAt: { gte: windowStart } } })
		);
	}
	checks.push(
		prisma.loginAttempt.count({ where: { ipHash, kind, createdAt: { gte: windowStart } } })
	);
	const counts = await Promise.all(checks);
	return counts.some((count) => count >= MAX_ATTEMPTS);
}

async function recordAttempt(kind: AttemptKind, ip: string, email?: string): Promise<void> {
	const ipHash = hashRateLimitKey(ip);
	const emailHash = email !== undefined ? hashRateLimitKey(email) : null;
	const cleanupBefore = new Date(Date.now() - WINDOW_MS * 4);
	await Promise.all([
		prisma.loginAttempt.create({ data: { emailHash, ipHash, kind } }),
		prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: cleanupBefore } } })
	]);
}

export async function isLoginRateLimited(email: string, ip: string): Promise<boolean> {
	return isRateLimited('LOGIN', ip, email);
}

export async function recordFailedLoginAttempt(email: string, ip: string): Promise<void> {
	await recordAttempt('LOGIN', ip, email);
}

export async function isRegisterRateLimited(ip: string): Promise<boolean> {
	return isRateLimited('REGISTER', ip);
}

export async function recordRegisterAttempt(ip: string): Promise<void> {
	await recordAttempt('REGISTER', ip);
}

export async function isInviteRateLimited(ip: string): Promise<boolean> {
	return isRateLimited('INVITE', ip);
}

export async function recordInviteAttempt(ip: string): Promise<void> {
	await recordAttempt('INVITE', ip);
}

// Same mechanism as LOGIN: limited by IP AND by hashed MFA challenge id, so
// an attacker can't bypass the limit by generating a new challenge on every
// attempt (e.g. several valid passwords tried on different accounts from the
// same IP, or challenge spam).
export async function isMfaRateLimited(challengeId: string, ip: string): Promise<boolean> {
	return isRateLimited('MFA', ip, challengeId);
}

export async function recordMfaAttempt(challengeId: string, ip: string): Promise<void> {
	await recordAttempt('MFA', ip, challengeId);
}

// Consent-start actions (start/renew) each trigger an outbound call to the bank
// provider (createConnection). Limited by IP AND by hashed userId, same rationale
// as MFA: an authenticated account can't be used to hammer the provider from a
// single IP, nor from many IPs on a single account.
export async function isBankSyncStartRateLimited(userId: string, ip: string): Promise<boolean> {
	return isRateLimited('BANK_SYNC_START', ip, userId);
}

export async function recordBankSyncStartAttempt(userId: string, ip: string): Promise<void> {
	await recordAttempt('BANK_SYNC_START', ip, userId);
}

// One shared counter for every settings action that re-verifies a secret (deleteAccount,
// changePassword, disableTotp, confirmTotpSetup). Keyed by userId AND IP, same as MFA/BANK_SYNC:
// the userId dimension stops an attacker rotating IPs, the IP dimension stops one address spraying.
// It MUST be shared, not per-action: all four test the same password, so a per-action counter would
// hand an attacker four times the guessing budget. Callers record ONLY on a wrong secret (never on
// a mistyped confirmation phrase or a malformed field), so an honest owner cannot lock themselves
// out by legitimate use, and check the limit BEFORE the expensive verify so a tripped counter
// short-circuits.
export async function isReauthRateLimited(userId: string, ip: string): Promise<boolean> {
	return isRateLimited('REAUTH', ip, userId);
}

export async function recordReauthAttempt(userId: string, ip: string): Promise<void> {
	await recordAttempt('REAUTH', ip, userId);
}
