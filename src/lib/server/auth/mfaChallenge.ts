import type { Cookies } from '@sveltejs/kit';
import {
	createSessionToken,
	hashSessionToken,
	areSecureCookiesEnabled,
	signInFactorsStillCurrent,
	SignInSuperseded,
	type SignInFactors,
	type TransactionClient
} from '$lib/server/auth';
import { isTransientWriteConflict, withConcurrentWriteRetry } from '$lib/server/database/upsert';
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
// Written only while the account still signs in the way the password step read it would (#923,
// #949): a change to the password or to two-factor committed during the comparison throws
// `SignInSuperseded`, one committed after deletes the row.
export async function createMfaChallenge(
	userId: string,
	read: SignInFactors,
	cookies: Cookies
): Promise<void> {
	const token = createSessionToken();
	const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

	await prisma.pendingMfaChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });
	await withConcurrentWriteRetry(
		() =>
			prisma.$transaction(async (tx) => {
				await signInFactorsStillCurrent(tx, userId, read);
				await tx.pendingMfaChallenge.create({
					data: { userId, tokenHash: hashSessionToken(token), expiresAt }
				});
			}),
		isTransientWriteConflict
	);

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

/**
 * Claims the challenge for the session written in the same transaction (`createSession`'s
 * `stillProven`), after a valid code: deleted here, and only if it is still there and unexpired.
 * A challenge ended meanwhile by a password change, turning two-factor off, or « log out other
 * sessions » (`endPendingSignIns`) matches nothing, and the sign-in is refused with
 * `SignInSuperseded` (#923).
 * Checked by the count, never by an earlier read: the read at the start of the request is what a
 * change landing during the code check makes stale.
 */
export async function claimMfaChallenge(tx: TransactionClient, id: string): Promise<void> {
	const { count } = await tx.pendingMfaChallenge.deleteMany({
		where: { id, expiresAt: { gt: new Date() } }
	});
	if (count !== 1) throw new SignInSuperseded();
}

// Single-use, called when MFA was disabled in the meantime: a failed code doesn't consume the
// challenge, only rate limiting by challenge id + IP bounds the number of attempts.
export async function consumeMfaChallenge(id: string, cookies: Cookies): Promise<void> {
	await prisma.pendingMfaChallenge.deleteMany({ where: { id } });
	clearMfaChallengeCookie(cookies);
}

export function clearMfaChallengeCookie(cookies: Cookies): void {
	cookies.delete(MFA_PENDING_COOKIE, { path: '/' });
}
