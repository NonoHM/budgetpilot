import type { Cookies } from '@sveltejs/kit';
import { createSessionToken, hashSessionToken, areSecureCookiesEnabled } from '$lib/server/auth';
import { prisma } from '$lib/server/db';

export const MFA_PENDING_COOKIE = 'budgetpilot_mfa_pending';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function getChallengeCookieOptions(expires: Date) {
	return {
		httpOnly: true,
		sameSite: 'lax' as const,
		secure: areSecureCookiesEnabled(),
		path: '/',
		expires
	};
}

// Opaque token like Session: only its hash is persisted, never the userId in clear
// text client-side. Never creates a usable session — just a token pending a TOTP code.
export async function createMfaChallenge(userId: string, cookies: Cookies): Promise<void> {
	const token = createSessionToken();
	const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

	await prisma.pendingMfaChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });
	await prisma.pendingMfaChallenge.create({
		data: { userId, tokenHash: hashSessionToken(token), expiresAt }
	});

	cookies.set(MFA_PENDING_COOKIE, token, getChallengeCookieOptions(expiresAt));
}

export interface PendingChallenge {
	id: string;
	userId: string;
}

export async function readMfaChallenge(cookies: Cookies): Promise<PendingChallenge | null> {
	const token = cookies.get(MFA_PENDING_COOKIE);
	if (!token) return null;

	const tokenHash = hashSessionToken(token);
	const challenge = await prisma.pendingMfaChallenge.findUnique({
		where: { tokenHash },
		select: { id: true, userId: true, expiresAt: true }
	});
	if (!challenge || challenge.expiresAt <= new Date()) return null;

	return { id: challenge.id, userId: challenge.userId };
}

// Single-use, called only after a valid TOTP/backup code (or if MFA was
// disabled in the meantime): a failed code doesn't consume the challenge, only rate
// limiting by challenge id + IP bounds the number of attempts.
export async function consumeMfaChallenge(id: string, cookies: Cookies): Promise<void> {
	await prisma.pendingMfaChallenge.deleteMany({ where: { id } });
	clearMfaChallengeCookie(cookies);
}

export function clearMfaChallengeCookie(cookies: Cookies): void {
	cookies.delete(MFA_PENDING_COOKIE, { path: '/' });
}
