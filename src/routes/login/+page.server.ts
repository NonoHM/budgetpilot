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
import { resolveClientAddress } from '$lib/server/net/clientAddress';
import { ensureDefaultCategoriesSeeded } from '$lib/server/categories/defaults';
import { ensureDefaultRulesSeeded } from '$lib/server/categorization/defaultRules';
import { prisma } from '$lib/server/db';
import type { PageServerLoad } from './$types';

/**
 * Notices this screen will show, ALLOWLISTED rather than reflected. The parameter selects a
 * catalogue message; its value is never rendered. A reflected query parameter above a real
 * password field is how a phishing link puts its own sentence on a page the visitor trusts, and
 * "it is only ever set by our own redirect" is a fact about our links, not about the ones a
 * visitor clicks.
 */
const NOTICES = ['registration_closed'] as const;
type Notice = (typeof NOTICES)[number];

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.user) throw redirect(303, getSafeRedirect(url.searchParams.get('redirectTo')));
	const requested = url.searchParams.get('notice');
	return {
		canRegister: await isSelfRegistrationOpen(),
		notice: NOTICES.includes(requested as Notice) ? (requested as Notice) : null
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

		const ip = resolveClientAddress({ getClientAddress, request });
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
