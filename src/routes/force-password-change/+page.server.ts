import { fail, redirect, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import {
	commitWithRotatedToken,
	hashPassword,
	requireUser,
	revokeSessionsOtherThan,
	validatePassword
} from '$lib/server/auth';
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

		if (
			!newPassword ||
			!confirmPassword ||
			newPassword !== confirmPassword ||
			!validatePassword(newPassword)
		) {
			return fail(400, { passwordError: m.force_password_error_invalid() });
		}

		const newPasswordHash = await hashPassword(newPassword);

		// The same end state as `changePassword` (R3 on #841): every other session revoked and this
		// one's token replaced in the same commit, so no token that predates the new password outlives
		// it (#249). No current password is asked here; whether one should be is #880's question.
		await commitWithRotatedToken(user, cookies, async (tx) => {
			await tx.user.update({
				where: { id: user.id },
				data: {
					passwordHash: newPasswordHash,
					forcePasswordChange: false
				}
			});

			await revokeSessionsOtherThan(tx, user);
		});

		throw redirect(303, '/');
	}
};

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}
