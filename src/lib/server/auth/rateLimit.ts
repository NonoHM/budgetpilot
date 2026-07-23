import { createHmac } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const rawHashSecret = env.RATE_LIMIT_HASH_SECRET;
if (!rawHashSecret) {
	throw new Error('RATE_LIMIT_HASH_SECRET is required (set it in your environment)');
}
const RATE_LIMIT_HASH_SECRET: string = rawHashSecret;

type AttemptKind = 'LOGIN' | 'REGISTER' | 'INVITE' | 'MFA' | 'BANK_SYNC_START';

function hashRateLimitKey(value: string): string {
	return createHmac('sha256', RATE_LIMIT_HASH_SECRET)
		.update(value.trim().toLowerCase())
		.digest('hex');
}

async function isRateLimited(kind: AttemptKind, ip: string, email?: string): Promise<boolean> {
	const ipHash = hashRateLimitKey(ip);
	const windowStart = new Date(Date.now() - WINDOW_MS);
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
