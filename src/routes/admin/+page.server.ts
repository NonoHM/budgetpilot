import { forgetAdvice } from '$lib/server/ai/gateway';
import { fail, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import {
	commitWithRotatedToken,
	endPendingSignIns,
	generateTemporaryPassword,
	hashPassword,
	isNonAsciiEmail,
	requireAdmin,
	validateNewEmail
} from '$lib/server/auth';
import {
	createInvitation,
	listPendingInvitations,
	revokeInvitation
} from '$lib/server/auth/invitations';
import { reauthenticate, reauthRefusalMessage } from '$lib/server/auth/reauth';
import { resolveClientAddress } from '$lib/server/net/clientAddress';
import { prisma } from '$lib/server/db';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 20;

export const load: PageServerLoad = async ({ locals, url }) => {
	const admin = requireAdmin(locals.user);
	const page = parsePositiveInteger(url.searchParams.get('page')) ?? 1;

	const totalUsers = await prisma.user.count();
	const totalPages = Math.max(1, Math.ceil(totalUsers / PAGE_SIZE));
	const safePage = Math.min(page, totalPages);

	const [users, invitations, adminAccount] = await Promise.all([
		prisma.user.findMany({
			select: {
				id: true,
				email: true,
				role: true,
				createdAt: true,
				_count: {
					select: {
						transactions: true,
						categories: true,
						monthlyBudgets: true
					}
				}
			},
			orderBy: { createdAt: 'asc' },
			skip: (safePage - 1) * PAGE_SIZE,
			take: PAGE_SIZE
		}),
		listPendingInvitations(),
		// Whether the admin's OWN re-authentication asks for a code (#229): the dialogs render the
		// field only then, and the server asks for it regardless of what the page rendered.
		prisma.user.findUnique({ where: { id: admin.id }, select: { totpEnabled: true } })
	]);

	return {
		currentUserId: admin.id,
		reauthAsksCode: adminAccount?.totpEnabled === true,
		users: users.map((user) => ({
			id: user.id,
			email: user.email,
			role: user.role,
			createdAt: user.createdAt,
			transactionCount: user._count.transactions,
			categoryCount: user._count.categories,
			budgetCount: user._count.monthlyBudgets
		})),
		pagination: {
			page: safePage,
			totalPages,
			totalUsers,
			hasPrevious: safePage > 1,
			hasNext: safePage < totalPages
		},
		invitations
	};
};

export const actions: Actions = {
	deleteUser: async ({ cookies, getClientAddress, locals, request }) => {
		const admin = requireAdmin(locals.user);
		const ip = resolveClientAddress({ getClientAddress, request });
		const formData = await request.formData();
		const targetUserId = getFormValue(formData, 'targetUserId');

		if (!targetUserId) return fail(400, { deleteError: m.admin_error_invalid_user() });
		if (targetUserId === admin.id) return fail(400, { deleteError: m.admin_error_self_delete() });

		// #229: the ADMIN proves their own password, plus TOTP when they have it, before acting on
		// another account. Ahead of the target lookup, so an admin session alone learns nothing more.
		const reauth = await reauthenticate('deleteUser', { user: admin, ip, form: formData });
		if (!reauth.ok) return fail(400, { deleteError: reauthRefusalMessage(reauth) });

		const target = await prisma.user.findUnique({
			where: { id: targetUserId },
			select: { id: true }
		});
		if (!target) return fail(404, { deleteError: m.admin_error_user_not_found() });

		// The ADMIN's session token is replaced in the same commit (#249).
		await commitWithRotatedToken(admin, cookies, async (tx) => {
			await tx.session.deleteMany({ where: { userId: targetUserId } });
			// Transactions before the user — see the identical comment in settings/+page.server.ts's
			// deleteAccount. Deleting the user cascades into Category and Transaction in an order
			// the engine chooses, and TransactionSplit is RESTRICT on Category, so on PostgreSQL
			// the delete fails outright for any user who has ever split a transaction.
			await tx.transaction.deleteMany({ where: { userId: targetUserId } });
			await tx.user.delete({ where: { id: targetUserId } });
		});
		// #535: the deleted account's cached advice and any running generation end with it.
		forgetAdvice(targetUserId);

		return { deleteSuccess: m.admin_delete_success() };
	},
	resetPassword: async ({ cookies, getClientAddress, locals, request }) => {
		const admin = requireAdmin(locals.user);
		const ip = resolveClientAddress({ getClientAddress, request });
		const formData = await request.formData();
		const targetUserId = getFormValue(formData, 'targetUserId');

		if (!targetUserId) return fail(400, { resetError: m.admin_error_invalid_user() });
		if (targetUserId === admin.id) return fail(400, { resetError: m.admin_error_self_reset() });

		// #229: same gate as deleteUser. A reset hands whoever holds the session a working password
		// for another account, so a session alone must not be enough.
		const reauth = await reauthenticate('resetPassword', { user: admin, ip, form: formData });
		if (!reauth.ok) return fail(400, { resetError: reauthRefusalMessage(reauth) });

		const target = await prisma.user.findUnique({
			where: { id: targetUserId },
			select: { id: true, email: true }
		});
		if (!target) return fail(404, { resetError: m.admin_error_user_not_found() });

		const temporaryPassword = generateTemporaryPassword();
		const passwordHash = await hashPassword(temporaryPassword);

		await commitWithRotatedToken(admin, cookies, async (tx) => {
			await tx.user.update({
				where: { id: targetUserId },
				data: {
					passwordHash,
					forcePasswordChange: true
				}
			});
			// The target's sign-ins waiting at their code step end with the password, before the
			// sessions (#923, see `endPendingSignIns`).
			await endPendingSignIns(tx, targetUserId);
			await tx.session.deleteMany({ where: { userId: targetUserId } });
		});

		return {
			resetTargetUserId: targetUserId,
			resetTargetEmail: target.email,
			temporaryPassword
		};
	},
	createInvitation: async ({ locals, request }) => {
		const admin = requireAdmin(locals.user);
		const formData = await request.formData();
		const rawEmail = getFormValue(formData, 'email');
		const email = rawEmail ? validateNewEmail(rawEmail) : null;
		if (rawEmail && !email) {
			// Same split as /register: an address rejected only by the ASCII rule is well-formed,
			// so saying "invalid" would send the admin looking for a typo that is not there.
			return fail(400, {
				inviteError: isNonAsciiEmail(rawEmail)
					? m.admin_error_email_non_ascii()
					: m.admin_error_invalid_email()
			});
		}

		const invitation = await createInvitation(admin.id, email);
		const inviteUrl = new URL(`/register?invite=${invitation.token}`, request.url).toString();

		return {
			inviteUrl,
			inviteEmail: invitation.email,
			inviteExpiresAt: invitation.expiresAt.toISOString()
		};
	},
	revokeInvitation: async ({ locals, request }) => {
		requireAdmin(locals.user);
		const formData = await request.formData();
		const invitationId = getFormValue(formData, 'invitationId');
		if (!invitationId)
			return fail(400, { revokeInviteError: m.admin_error_invitation_not_found() });

		const revoked = await revokeInvitation(invitationId);
		if (!revoked) return fail(404, { revokeInviteError: m.admin_error_invitation_not_found() });

		return { revokeInviteSuccess: m.admin_invitation_revoked() };
	}
};

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}

function parsePositiveInteger(value: string | null): number | null {
	if (!value || !/^\d+$/.test(value)) return null;
	const parsed = Number(value);
	return parsed > 0 ? parsed : null;
}
