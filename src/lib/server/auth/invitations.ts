import { createSessionToken, hashSessionToken, normalizeEmail } from '$lib/server/auth';
import { prisma } from '$lib/server/db';

const DEFAULT_INVITATION_TTL_HOURS = 72;

// Same "parse+fallback" helper as SESSION_TTL_DAYS/PASSWORD_HASH_COST: read on every call,
// not cached, to stay configurable without a stateful redeploy.
function getInvitationTtlHours(): number {
	const raw = Number(process.env.INVITATION_TTL_HOURS ?? DEFAULT_INVITATION_TTL_HOURS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INVITATION_TTL_HOURS;
}

export interface CreatedInvitation {
	id: string;
	token: string;
	email: string | null;
	expiresAt: Date;
}

export async function createInvitation(
	createdByUserId: string,
	email: string | null
): Promise<CreatedInvitation> {
	const token = createSessionToken();
	const expiresAt = new Date(Date.now() + getInvitationTtlHours() * 60 * 60 * 1000);
	const normalizedEmail = email ? normalizeEmail(email) : null;

	const invitation = await prisma.invitation.create({
		data: {
			tokenHash: hashSessionToken(token),
			email: normalizedEmail,
			createdByUserId,
			expiresAt
		},
		select: { id: true }
	});

	return { id: invitation.id, token, email: normalizedEmail, expiresAt };
}

export interface PendingInvitation {
	id: string;
	email: string | null;
	expiresAt: Date;
	createdAt: Date;
}

export async function listPendingInvitations(): Promise<PendingInvitation[]> {
	return prisma.invitation.findMany({
		where: { usedAt: null, revokedAt: null },
		orderBy: { createdAt: 'desc' },
		select: { id: true, email: true, expiresAt: true, createdAt: true }
	});
}

// Soft-revoke only: keeps the history (like Session.revokedAt), no physical deletion.
// Never revokes an already-consumed invitation (usedAt not null): the usedAt: null
// filter makes this operation a safe no-op on an already-used invitation.
export async function revokeInvitation(id: string): Promise<boolean> {
	const result = await prisma.invitation.updateMany({
		where: { id, revokedAt: null, usedAt: null },
		data: { revokedAt: new Date() }
	});
	return result.count === 1;
}

export interface ValidInvitation {
	id: string;
	email: string | null;
}

// Read-only, for /register gating (load + early guard in the action). The real,
// definitively atomic consumption happens via a conditional updateMany in the account
// creation transaction (see register/+page.server.ts): this lookup alone does NOT
// guarantee single-use under concurrency.
export async function findValidInvitationByToken(token: string): Promise<ValidInvitation | null> {
	if (!token) return null;

	const tokenHash = hashSessionToken(token);
	const invitation = await prisma.invitation.findUnique({
		where: { tokenHash },
		select: { id: true, email: true, usedAt: true, revokedAt: true, expiresAt: true }
	});
	if (!invitation) return null;
	if (invitation.usedAt || invitation.revokedAt) return null;
	if (invitation.expiresAt <= new Date()) return null;

	return { id: invitation.id, email: invitation.email };
}
