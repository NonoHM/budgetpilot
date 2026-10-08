import { fail, redirect, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import {
	createSession,
	passwordStillCurrent,
	redirectAfterSignIn,
	secondFactorUrl,
	SESSION_COOKIE,
	sessionEndedByInactivity,
	SignInSuperseded,
	validateEmail,
	verifyPasswordTimingSafe
} from '$lib/server/auth';
import { createMfaChallenge } from '$lib/server/auth/mfaChallenge';
import { isSelfRegistrationOpen } from '$lib/server/auth/registration';
import { isLoginRateLimited, recordFailedLoginAttempt } from '$lib/server/auth/rateLimit';
import { resolveClientAddress } from '$lib/server/net/clientAddress';
import {
	logRateLimited,
	logSecondFactorRequired,
	logSignInFailed,
	logSignInSucceeded
} from '$lib/server/logging/authn';
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

export const load: PageServerLoad = async ({ cookies, locals, url }) => {
	if (locals.user) redirectAfterSignIn(url);
	const requested = url.searchParams.get('notice');
	return {
		canRegister: await isSelfRegistrationOpen(),
		notice: NOTICES.includes(requested as Notice) ? (requested as Notice) : null,
		// Why this visitor is signed out, when it is inactivity (#221). Read from the cookie the
		// browser still holds (`handleAuth` leaves it in place), never from the URL, so no link can
		// put this sentence on the page.
		signedOutIdle: await sessionEndedByInactivity(cookies.get(SESSION_COOKIE))
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
		const trip = await isLoginRateLimited(email, ip);
		if (trip) {
			logRateLimited('LOGIN', trip, ip);
			return tooManyAttempts();
		}

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
			logSignInFailed(
				ip,
				user
					? { step: 'password', reason: 'wrong_password', userId: user.id }
					: { step: 'password', reason: 'unknown_account' }
			);
			return invalid();
		}

		// What the comparison proved is written only while it still holds (#923): a password changed
		// while bcrypt ran is the old password, refused as any wrong one is.
		const verifiedHash = user.passwordHash;
		try {
			if (user.totpEnabled) {
				await createMfaChallenge(user.id, verifiedHash, cookies);
				logSecondFactorRequired(ip, user.id);
				throw redirect(303, secondFactorUrl(url));
			}

			await ensureDefaultCategoriesSeeded(user.id);
			await ensureDefaultRulesSeeded(user.id);
			await createSession(user.id, cookies, (tx) =>
				passwordStillCurrent(tx, user.id, verifiedHash)
			);
		} catch (caught) {
			if (!(caught instanceof SignInSuperseded)) throw caught;
			await recordFailedLoginAttempt(email, ip);
			logSignInFailed(ip, { step: 'password', reason: 'superseded', userId: user.id });
			return invalid();
		}
		logSignInSucceeded(ip, user.id, 'password');
		redirectAfterSignIn(url);
	}
};

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}
