import { fail, redirect, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { createSession, redirectAfterSignIn, SignInSuperseded } from '$lib/server/auth';
import {
	claimMfaChallenge,
	clearMfaChallengeCookie,
	consumeMfaChallenge,
	readMfaChallenge
} from '$lib/server/auth/mfaChallenge';
import { isMfaRateLimited, recordMfaAttempt } from '$lib/server/auth/rateLimit';
import { refuseSignIn } from '$lib/server/auth/signInRefusal';
import { resolveClientAddress } from '$lib/server/net/clientAddress';
import {
	logRateLimited,
	logSecretUnreadable,
	logSignInSucceeded,
	type SignInFailure
} from '$lib/server/logging/authn';
import { consumeRecoveryCode, RECOVERY_CODE_PATTERN } from '$lib/server/auth/recoveryCodes';
import { acceptTotpCode, type TotpAcceptance } from '$lib/server/auth/totpAcceptance';
import { ensureDefaultCategoriesSeeded } from '$lib/server/categories/defaults';
import { ensureDefaultRulesSeeded } from '$lib/server/categorization/defaultRules';
import { prisma } from '$lib/server/db';
import type { PageServerLoad } from './$types';

const TOTP_CODE_PATTERN = /^[0-9]{6}$/;

export const load: PageServerLoad = async ({ cookies }) => {
	const challenge = await readMfaChallenge(cookies);
	if (!challenge) throw redirect(303, '/login');
	return {};
};

export const actions: Actions = {
	default: async ({ cookies, getClientAddress, request, setHeaders, url }) => {
		const invalid = () => fail(400, { error: m.mfa_verify_error_invalid_code() });
		const tooManyAttempts = () => fail(400, { error: m.mfa_verify_error_too_many_attempts() });

		const challenge = await readMfaChallenge(cookies);
		if (!challenge) throw redirect(303, '/login');

		const ip = resolveClientAddress({ getClientAddress, request });
		const trip = await isMfaRateLimited(challenge.id, ip);
		if (trip) {
			logRateLimited('MFA', trip, ip, challenge.userId);
			return tooManyAttempts();
		}

		const formData = await request.formData();
		const code = getFormValue(formData, 'code').trim();
		if (!code) return invalid();

		const user = await prisma.user.findUnique({
			where: { id: challenge.userId },
			select: { id: true, totpEnabled: true, totpSecretEncrypted: true }
		});

		if (!user || !user.totpEnabled || !user.totpSecretEncrypted) {
			// MFA was disabled in the meantime (another tab): the challenge no longer makes sense.
			await consumeMfaChallenge(challenge.id, cookies);
			throw redirect(303, '/login');
		}

		// A TOTP code is spent here, by `acceptTotpCode`, even if the sign-in then fails: see why there.
		let verdict: TotpAcceptance = 'wrong';
		// What the log says a refused code was. A string matching neither pattern still costs an
		// attempt, because the limiter counts every guess at this step.
		let refused: Extract<SignInFailure, { step: 'second_factor' }>['reason'] = 'unrecognised_code';
		const factor = TOTP_CODE_PATTERN.test(code) ? 'totp' : 'recovery_code';
		if (TOTP_CODE_PATTERN.test(code)) {
			verdict = await acceptTotpCode(user.id, user.totpSecretEncrypted, code);
			refused =
				verdict === 'reused'
					? 'reused_code'
					: verdict === 'unreadable'
						? 'unreadable_secret'
						: 'wrong_code';
			// #904: the configured key is not the one the secret was stored with. The operator's line.
			if (verdict === 'unreadable') logSecretUnreadable(user.id);
		} else if (RECOVERY_CODE_PATTERN.test(code)) {
			verdict = (await consumeRecoveryCode(user.id, code)) ? 'accepted' : 'wrong';
			refused = 'wrong_recovery_code';
		}

		if (verdict !== 'accepted') {
			await recordMfaAttempt(challenge.id, ip);
			refuseSignIn(setHeaders, ip, { step: 'second_factor', reason: refused, userId: user.id });
			// A spent code says so (#818): whoever typed it twice needs the next one, not a clock
			// check. Nothing in that is usable: the password is already proven at this step, and a
			// spent step is never accepted again. A secret that does not decrypt says so too (#904):
			// no code from the app can pass, and a recovery code still can, which is what to do next.
			if (verdict === 'reused') return fail(400, { error: m.totp_error_code_reused() });
			if (verdict === 'unreadable') return fail(400, { error: m.totp_error_secret_unreadable() });
			return invalid();
		}

		await ensureDefaultCategoriesSeeded(user.id);
		await ensureDefaultRulesSeeded(user.id);
		// The challenge is claimed in the session's own transaction (#923): one ended since the read
		// above, by a password change, turning two-factor off or « log out other sessions », is sent
		// back to the password step.
		try {
			await createSession(user.id, cookies, (tx) => claimMfaChallenge(tx, challenge.id));
		} catch (caught) {
			if (!(caught instanceof SignInSuperseded)) throw caught;
			refuseSignIn(setHeaders, ip, {
				step: 'second_factor',
				reason: 'superseded',
				userId: user.id
			});
			clearMfaChallengeCookie(cookies);
			throw redirect(303, '/login');
		}
		clearMfaChallengeCookie(cookies);
		logSignInSucceeded(ip, user.id, factor);

		redirectAfterSignIn(url);
	}
};

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}
