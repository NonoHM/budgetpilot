import { fail, redirect, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import {
	createSession,
	getSafeRedirect,
	validateEmail,
	verifyPasswordTimingSafe
} from '$lib/server/auth';
import { createMfaChallenge } from '$lib/server/auth/mfaChallenge';
import { isSelfRegistrationOpen } from '$lib/server/auth/registration';
import { isLoginRateLimited, recordFailedLoginAttempt } from '$lib/server/auth/rateLimit';
import { ensureDefaultCategoriesSeeded } from '$lib/server/categories/defaults';
import { ensureDefaultRulesSeeded } from '$lib/server/categorization/defaultRules';
import { prisma } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.user) throw redirect(303, getSafeRedirect(url.searchParams.get('redirectTo')));
	return {
		canRegister: await isSelfRegistrationOpen()
	};
};

export const actions: Actions = {
	default: async ({ cookies, getClientAddress, request, url }) => {
		const formData = await request.formData();
		const rawEmail = getFormValue(formData, 'email');
		const email = validateEmail(rawEmail);
		const password = getFormValue(formData, 'password');
		const invalid = () => fail(400, { error: m.login_error_invalid_credentials() });
		const tooManyAttempts = () => fail(400, { error: m.login_error_too_many_attempts() });

		if (!email || !password) return invalid();

		const ip = getClientAddress();
		if (await isLoginRateLimited(email, ip)) return tooManyAttempts();

		const user = await prisma.user.findUnique({
			where: { email },
			select: {
				id: true,
				passwordHash: true,
				totpEnabled: true
			}
		});

		const passwordOk = await verifyPasswordTimingSafe(password, user?.passwordHash);
		if (!user || !passwordOk) {
			await recordFailedLoginAttempt(email, ip);
			return invalid();
		}

		const redirectTo = getSafeRedirect(url.searchParams.get('redirectTo'));

		if (user.totpEnabled) {
			await createMfaChallenge(user.id, cookies);
			const target = new URL('/login/verify-totp', url);
			target.searchParams.set('redirectTo', redirectTo);
			throw redirect(303, target.pathname + target.search);
		}

		await ensureDefaultCategoriesSeeded(user.id);
		await ensureDefaultRulesSeeded(user.id);
		await createSession(user.id, cookies);
		throw redirect(303, redirectTo);
	}
};

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}
