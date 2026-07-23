import { timingSafeEqual } from 'node:crypto';
import { error, fail, redirect, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import {
	BACKFILL_USER_EMAIL,
	BACKFILL_USER_ID,
	createSession,
	hashPassword,
	validateEmail,
	validatePassword
} from '$lib/server/auth';
import { findValidInvitationByToken } from '$lib/server/auth/invitations';
import { getRegistrationMode, isOnlyBackfillUser } from '$lib/server/auth/registration';
import {
	isInviteRateLimited,
	isRegisterRateLimited,
	recordInviteAttempt,
	recordRegisterAttempt
} from '$lib/server/auth/rateLimit';
import { ensureDefaultCategoriesSeeded } from '$lib/server/categories/defaults';
import { ensureDefaultRulesSeeded } from '$lib/server/categorization/defaultRules';
import { prisma } from '$lib/server/db';
import type { PageServerLoad } from './$types';
import { env } from '$env/dynamic/private';

export const load: PageServerLoad = async ({ locals, url }) => {
	const inviteToken = url.searchParams.get('invite') ?? '';
	const invitation = inviteToken ? await findValidInvitationByToken(inviteToken) : null;
	if (inviteToken && !invitation) throw error(410, m.register_error_invitation_invalid());

	if (getRegistrationMode() === 'open' || invitation) {
		return { canRegister: true, inviteEmail: invitation?.email ?? null };
	}

	const canClaimBackfillUser = await isOnlyBackfillUser();
	const userCount = canClaimBackfillUser ? 0 : await prisma.user.count();
	const canRegister = userCount === 0 || locals.user?.role === 'ADMIN';
	if (!canRegister && !locals.user) throw redirect(303, '/login');
	if (!canRegister) throw error(403, m.register_error_admin_only());

	return {
		canRegister,
		inviteEmail: null
	};
};

export const actions: Actions = {
	default: async ({ cookies, getClientAddress, locals, request, url }) => {
		const registrationMode = getRegistrationMode();
		const isOpenRegistration = registrationMode === 'open';
		const inviteToken = url.searchParams.get('invite') ?? '';
		const ip = getClientAddress();

		if (inviteToken) {
			if (await isInviteRateLimited(ip)) {
				return fail(429, { error: m.register_error_too_many_attempts() });
			}
			await recordInviteAttempt(ip);
		}

		const invitation = inviteToken ? await findValidInvitationByToken(inviteToken) : null;
		if (inviteToken && !invitation) {
			return fail(410, { error: m.register_error_invitation_invalid() });
		}

		if (isOpenRegistration && !invitation) {
			const ipRateLimited = await isRegisterRateLimited(ip);
			if (ipRateLimited) {
				return fail(429, { error: m.register_error_too_many_attempts() });
			}
			// In "open" mode, the attack is repeated successful creation
			// (mass account creation): so we count every processed submission,
			// successes included, not just failures.
			await recordRegisterAttempt(ip);
		}

		const canClaimBackfillUser = invitation ? false : await isOnlyBackfillUser();
		const userCount = canClaimBackfillUser ? 0 : await prisma.user.count();
		const canRegister =
			isOpenRegistration || Boolean(invitation) || userCount === 0 || locals.user?.role === 'ADMIN';
		if (!canRegister) return fail(403, { error: m.register_error_unavailable() });

		const formData = await request.formData();
		const email = validateEmail(getFormValue(formData, 'email'));
		const password = getFormValue(formData, 'password');
		const bootstrapToken = getFormValue(formData, 'bootstrapToken');

		if (!email) return fail(400, { error: m.register_error_invalid_email() });
		if (invitation?.email && invitation.email !== email) {
			return fail(400, { error: m.register_error_invitation_email_mismatch() });
		}
		if (!validatePassword(password)) {
			return fail(400, { error: m.register_error_invalid_password() });
		}
		if (
			!isOpenRegistration &&
			!invitation &&
			!locals.user &&
			!isBootstrapTokenValid(bootstrapToken)
		) {
			return fail(403, { error: m.register_error_unavailable() });
		}

		const passwordHash = await hashPassword(password);
		let user: { id: string };
		try {
			user = await createUser({
				canClaimBackfillUser,
				email,
				passwordHash,
				userCount,
				invitationId: invitation?.id
			});
		} catch (caught) {
			if (isUniqueConstraintError(caught)) return fail(400, { error: m.register_error_failed() });
			if (caught instanceof Error && caught.message === 'INVITATION_CONSUME_FAILED') {
				return fail(410, { error: m.register_error_invitation_invalid() });
			}
			throw caught;
		}

		await ensureDefaultCategoriesSeeded(user.id);
		await ensureDefaultRulesSeeded(user.id);

		if (!locals.user) {
			await createSession(user.id, cookies);
			throw redirect(303, '/');
		}

		return { success: m.register_success_user_created() };
	}
};

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}

async function createUser(input: {
	canClaimBackfillUser: boolean;
	email: string;
	passwordHash: string;
	userCount: number;
	invitationId?: string;
}) {
	if (input.invitationId) {
		return await createUserFromInvitation(input.invitationId, input.email, input.passwordHash);
	}
	return input.canClaimBackfillUser
		? await claimBackfillUser(input.email, input.passwordHash)
		: await prisma.$transaction(async (tx) => {
				const currentCount = await tx.user.count();
				if (currentCount !== input.userCount) throw new Error('REGISTRATION_RACE');
				return tx.user.create({
					data: {
						email: input.email,
						passwordHash: input.passwordHash,
						role: currentCount === 0 ? 'ADMIN' : 'USER'
					},
					select: {
						id: true
					}
				});
			});
}

// Marking the invitation as used happens in the SAME transaction as account creation,
// via a conditional updateMany (usedAt: null, revokedAt: null, expiresAt still valid) where
// only the affected row count is trusted: count !== 1 rolls back the transaction (undoing
// the created user), guaranteeing single-use under concurrency without a read-then-write window.
async function createUserFromInvitation(
	invitationId: string,
	email: string,
	passwordHash: string
): Promise<{ id: string }> {
	return prisma.$transaction(async (tx) => {
		const user = await tx.user.create({
			data: { email, passwordHash, role: 'USER' },
			select: { id: true }
		});
		const consumed = await tx.invitation.updateMany({
			where: {
				id: invitationId,
				usedAt: null,
				revokedAt: null,
				expiresAt: { gt: new Date() }
			},
			data: { usedAt: new Date(), usedByUserId: user.id }
		});
		if (consumed.count !== 1) throw new Error('INVITATION_CONSUME_FAILED');
		return user;
	});
}

async function claimBackfillUser(email: string, passwordHash: string): Promise<{ id: string }> {
	const result = await prisma.user.updateMany({
		where: {
			id: BACKFILL_USER_ID,
			email: BACKFILL_USER_EMAIL,
			passwordHash: 'BACKFILL_LOGIN_DISABLED'
		},
		data: {
			email,
			passwordHash,
			role: 'ADMIN'
		}
	});
	if (result.count !== 1) throw new Error('BACKFILL_CLAIM_FAILED');
	return { id: BACKFILL_USER_ID };
}

function isBootstrapTokenValid(value: string): boolean {
	const expected = env.BOOTSTRAP_TOKEN;
	if (!expected || !value) return false;
	const expectedBuf = Buffer.from(expected);
	const valueBuf = Buffer.from(value);
	// timingSafeEqual requires buffers of the same length: we always compare against a
	// buffer of the expected length (the real token if the sizes match, otherwise a
	// dummy buffer) to never leak the length via an early short-circuit.
	const lengthsMatch = valueBuf.length === expectedBuf.length;
	const comparand = lengthsMatch ? valueBuf : Buffer.alloc(expectedBuf.length);
	return timingSafeEqual(expectedBuf, comparand) && lengthsMatch;
}

function isUniqueConstraintError(caught: unknown): boolean {
	return (
		typeof caught === 'object' &&
		caught !== null &&
		'code' in caught &&
		(caught as { code?: string }).code === 'P2002'
	);
}
