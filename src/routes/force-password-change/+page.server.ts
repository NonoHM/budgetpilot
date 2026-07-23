import { fail, redirect, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import {
	hashPassword,
	hashSessionToken,
	requireUser,
	SESSION_COOKIE,
	validatePassword
} from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals.user);
	if (!user.forcePasswordChange) throw redirect(303, '/');
	return {};
};

export const actions: Actions = {
	default: async ({ cookies, locals, request }) => {
		const user = requireUser(locals.user);
		if (!user.forcePasswordChange) throw redirect(303, '/');

		const formData = await request.formData();
		const newPassword = getFormValue(formData, 'newPassword');
		const confirmPassword = getFormValue(formData, 'confirmPassword');
		const currentToken = cookies.get(SESSION_COOKIE);
		const currentTokenHash = currentToken ? hashSessionToken(currentToken) : null;

		if (
			!newPassword ||
			!confirmPassword ||
			newPassword !== confirmPassword ||
			!validatePassword(newPassword)
		) {
			return fail(400, { passwordError: m.force_password_error_invalid() });
		}

		const newPasswordHash = await hashPassword(newPassword);
		const now = new Date();

		await prisma.$transaction(async (tx) => {
			await tx.user.update({
				where: { id: user.id },
				data: {
					passwordHash: newPasswordHash,
					forcePasswordChange: false
				}
			});

			await tx.session.updateMany({
				where: {
					userId: user.id,
					revokedAt: null,
					...(currentTokenHash ? { tokenHash: { not: currentTokenHash } } : {})
				},
				data: {
					revokedAt: now
				}
			});
		});

		throw redirect(303, '/');
	}
};

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}
