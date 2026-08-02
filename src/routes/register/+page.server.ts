import { error, fail, redirect, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import {
	BACKFILL_USER_EMAIL,
	BACKFILL_USER_ID,
	createSession,
	hashPassword,
	isNonAsciiEmail,
	validateNewEmail,
	validatePassword
} from '$lib/server/auth';
import { isBootstrapTokenValid } from '$lib/server/auth/bootstrapToken';
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
		const email = validateNewEmail(getFormValue(formData, 'email'));
		const password = getFormValue(formData, 'password');
		const bootstrapToken = getFormValue(formData, 'bootstrapToken');

		if (!email) {
			// Which rule was broken, not just that one was: an invitation issued before the ASCII
			// rule existed names an address this route now refuses, and "Email invalide" in front
			// of a perfectly normal-looking address points at nothing. Depends only on what was
			// submitted, so it says nothing about which accounts exist.
			return fail(400, {
				error: isNonAsciiEmail(getFormValue(formData, 'email'))
					? m.register_error_email_non_ascii()
					: m.register_error_invalid_email()
			});
		}
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
			// Which rule was broken, not just that one was — the same reasoning as the email branch
			// above, applied to the token. "Inscription indisponible" was the message here, and it is
			// FALSE at this point: registration IS available, the token is simply wrong. It sends the
			// one person most likely to see it (a new operator, on the first screen, having pasted a
			// base64 value the docs warn is easy to truncate at the trailing `=`) looking for a
			// closed instance instead of at their own clipboard.
			//
			// It reveals nothing: reaching this line already means registration is open to whoever
			// holds the token, the form advertises a "Jeton bootstrap" field regardless, and neither
			// message says anything about which accounts exist.
			//
			// What does NOT bound guessing here is any rate limiter. The block near the top of this
			// action is gated on `isOpenRegistration && !invitation`, and this branch is by definition
			// neither — so token attempts are entirely unthrottled. Measured, not read: 250 wrong
			// tokens from one IP against a running instance, no throttling at any point, while the
			// login path trips its own limiter immediately. The 251st attempt with the correct token
			// created the account, which is what proves those 250 really did reach this check.
			// Tracked in the backlog as its own PR; the secrecy of the message was never the
			// protection and is not being asked to become it.
			return fail(403, { error: m.register_error_invalid_token() });
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

function isUniqueConstraintError(caught: unknown): boolean {
	return (
		typeof caught === 'object' &&
		caught !== null &&
		'code' in caught &&
		(caught as { code?: string }).code === 'P2002'
	);
}
